import { dateLocale, instantLocal } from './horaire.js';

/**
 * Le calcul de la consommation, en fonctions pures.
 *
 * On ne mesure pas des kilowattheures : on mesure une PUISSANCE, à intervalles
 * irréguliers. L'énergie s'en déduit par intégration, et c'est là que se
 * cachent les erreurs qui ne se voient pas.
 *
 * Deux précautions, qui expliquent la forme du code.
 *
 * 1. **Un trou n'est jamais comblé.** Si le serveur a été arrêté trois jours,
 *    la dernière mesure d'avant ne vaut pas pour ces trois jours. Au-delà de
 *    {@link TROU_MAX_MS} on cesse de compter et on le dit : mieux vaut annoncer
 *    « 60 % de la période mesurée » qu'un total inventé.
 * 2. **Les bornes sont locales, pas UTC.** « Aujourd'hui » commence à minuit
 *    chez soi. Un jour de changement d'heure fait 23 ou 25 heures, et le
 *    découpage doit le refléter.
 */

export type Periode = 'jour' | 'semaine' | 'mois';

export const PERIODE_LABELS: Record<Periode, string> = {
  jour: 'Jour',
  semaine: 'Semaine',
  mois: 'Mois',
};

/**
 * Au-delà de ce silence, on considère qu'on ne sait pas.
 *
 * Le simulateur bat toutes les 30 s, un canal HTTP interroge toutes les 30 s
 * et un canal Modbus toutes les 10 s : un quart d'heure laisse une marge
 * confortable. Une vraie coupure dure des heures, donc au pire on invente les
 * quinze premières minutes : négligeable : au lieu de combler trois jours.
 *
 * Une source plus lente que ce seuil : une courbe de charge au pas de trente
 * minutes, par exemple : doit passer son propre `trouMax` à {@link integrer},
 * sinon toutes ses mesures seraient écartées.
 */
export const TROU_MAX_MS = 15 * 60_000;

export interface Lecture {
  /** Millisecondes depuis 1970. */
  at: number;
  /** Puissance instantanée, en watts. */
  value: number;
}

export interface Seau {
  /** Début du seau, en millisecondes. */
  at: number;
  label: string;
  /** Énergie du seau, en kWh. */
  kwh: number;
  /** Vrai pour un seau entièrement à venir : on le dessine en creux. */
  futur: boolean;
}

export interface Bornes {
  debut: number;
  fin: number;
  /** La même période, juste avant, pour dire « par rapport à hier ». */
  precedentDebut: number;
  precedentFin: number;
  titre: string;
  /** Ce à quoi on se compare, en français. */
  comparaison: string;
}

/**
 * Les bornes d'une période, dans le fuseau de la maison.
 *
 * La période précédente est toujours prise SUR LA MÊME DURÉE ÉCOULÉE, jamais
 * entière. C'est le piège de tous les écrans de consommation : comparer huit
 * heures d'aujourd'hui aux vingt-quatre heures d'hier affiche −95 %, ce qui
 * est arithmétiquement exact et parfaitement mensonger. À huit heures du
 * matin, on se compare à hier huit heures du matin.
 */
export function bornesPeriode(periode: Periode, maintenant: Date, fuseau: string): Bornes {
  const { annee, mois, jour } = dateLocale(maintenant, fuseau);
  const now = maintenant.getTime();

  const NOMS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
                'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  let debut: number;
  let fin: number;
  let precedentDebut: number;
  let titre: string;
  let comparaison: string;

  if (periode === 'jour') {
    debut = instantLocal(annee, mois, jour, 0, 0, fuseau).getTime();
    fin = instantLocal(annee, mois, jour + 1, 0, 0, fuseau).getTime();
    precedentDebut = instantLocal(annee, mois, jour - 1, 0, 0, fuseau).getTime();
    titre = "Aujourd'hui";
    comparaison = 'par rapport à hier, même heure';
  } else if (periode === 'semaine') {
    debut = instantLocal(annee, mois, jour - 6, 0, 0, fuseau).getTime();
    fin = instantLocal(annee, mois, jour + 1, 0, 0, fuseau).getTime();
    precedentDebut = instantLocal(annee, mois, jour - 13, 0, 0, fuseau).getTime();
    titre = '7 derniers jours';
    comparaison = 'par rapport aux 7 jours précédents, même durée';
  } else {
    debut = instantLocal(annee, mois, 1, 0, 0, fuseau).getTime();
    fin = instantLocal(annee, mois, jour + 1, 0, 0, fuseau).getTime();
    const moisPrecedent = mois === 1 ? 12 : mois - 1;
    const anneePrecedente = mois === 1 ? annee - 1 : annee;
    precedentDebut = instantLocal(anneePrecedente, moisPrecedent, 1, 0, 0, fuseau).getTime();
    titre = NOMS[mois - 1]!.replace(/^./, (c) => c.toUpperCase());
    comparaison = `par rapport à ${NOMS[moisPrecedent - 1]}, même période`;
  }

  const ecoule = Math.max(0, Math.min(now, fin) - debut);
  return { debut, fin, precedentDebut, precedentFin: precedentDebut + ecoule, titre, comparaison };
}

/**
 * L'énergie consommée entre deux instants, en kWh, et la part du temps
 * réellement mesurée.
 *
 * Chaque paire de mesures consécutives vaut sa puissance moyenne pendant sa
 * durée : la règle du trapèze, qui vaut mieux qu'un escalier quand la
 * puissance varie continûment. Un intervalle plus long que {@link TROU_MAX_MS}
 * n'est pas compté du tout.
 */
export function integrer(
  lectures: Lecture[],
  debut: number,
  fin: number,
  trouMax = TROU_MAX_MS,
): { kwh: number; mesureMs: number } {
  let wattsMs = 0;
  let mesureMs = 0;

  for (let i = 1; i < lectures.length; i++) {
    const a = lectures[i - 1]!;
    const b = lectures[i]!;

    const t1 = Math.max(a.at, debut);
    const t2 = Math.min(b.at, fin);
    if (t2 <= t1) continue;

    const ecart = b.at - a.at;
    if (ecart <= 0 || ecart > trouMax) continue;

    // Puissance moyenne sur la portion retenue, interpolée aux bornes.
    const p1 = a.value + ((b.value - a.value) * (t1 - a.at)) / ecart;
    const p2 = a.value + ((b.value - a.value) * (t2 - a.at)) / ecart;
    wattsMs += ((p1 + p2) / 2) * (t2 - t1);
    mesureMs += t2 - t1;
  }

  return { kwh: wattsMs / 3_600_000 / 1000, mesureMs };
}

/** Découpe une période en seaux et intègre chacun. */
export function repartir(
  lectures: Lecture[],
  periode: Periode,
  bornes: Bornes,
  fuseau: string,
  maintenant: number,
): Seau[] {
  const { annee, mois, jour } = dateLocale(new Date(bornes.debut), fuseau);
  const seaux: Seau[] = [];

  const ajouter = (at: number, suivant: number, label: string) => {
    seaux.push({
      at,
      label,
      kwh: integrer(lectures, at, Math.min(suivant, bornes.fin)).kwh,
      futur: at > maintenant,
    });
  };

  if (periode === 'jour') {
    // On avance d'une heure RÉELLE, pas d'une heure murale.
    //
    // Un découpage par heure locale produisait 24 seaux le jour du passage à
    // l'heure d'été, alors que la journée en compte 23 : l'heure du milieu
    // n'existe pas, et `instantLocal` la ramenait sur la suivante, créant un
    // seau vide en double. En avançant de 3 600 000 ms on obtient 23, 24 ou 25
    // seaux selon le jour, chacun étiqueté de son heure locale.
    for (let at = bornes.debut; at < bornes.fin; at += 3_600_000) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: fuseau, hour: '2-digit', hour12: false,
      }).formatToParts(new Date(at));
      const h = Number(parts.find((x) => x.type === 'hour')?.value ?? 0) % 24;
      ajouter(at, at + 3_600_000, `${h}h`);
    }
    return seaux;
  }

  // Semaine et mois : un seau par jour.
  const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  for (let d = 0; ; d++) {
    const a = instantLocal(annee, mois, jour + d, 0, 0, fuseau).getTime();
    if (a >= bornes.fin) break;
    const b = instantLocal(annee, mois, jour + d + 1, 0, 0, fuseau).getTime();
    const local = dateLocale(new Date(a), fuseau);
    ajouter(a, b, periode === 'semaine' ? JOURS[local.jourSemaine]! : String(local.jour));
  }
  return seaux;
}

/** Le seau le plus chargé, ignorant ce qui n'est pas encore arrivé. */
export function pic(seaux: Seau[]): Seau | null {
  const passes = seaux.filter((s) => !s.futur);
  if (!passes.length) return null;
  return passes.reduce((a, b) => (a.kwh >= b.kwh ? a : b));
}
