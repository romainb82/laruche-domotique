import { JOURS_LONGS, type SceneCondition, type SceneTrigger } from './config.js';

/**
 * Le calcul des horaires, en fonctions pures.
 *
 * Tout est isolé ici pour une raison : c'est le seul endroit du projet où une
 * erreur ne se voit pas. Un volet qui s'ouvre à 6 h au lieu de 7 h pendant six
 * mois de l'année ne provoque aucune erreur, aucun journal, aucune alerte : * juste quelqu'un qui se réveille trop tôt et qui finit par couper la règle.
 *
 * D'où le passage par le fuseau CONFIGURÉ plutôt que par l'heure de la
 * machine. Un serveur peut tourner en UTC, dans un conteneur, ou déménager.
 * « 07:00 » veut dire sept heures du matin chez soi, pas sept heures quelque
 * part.
 */

/**
 * De combien de minutes un fuseau devance UTC, à cet instant précis.
 *
 * On lit l'heure murale du fuseau, on la relit comme si c'était de l'UTC, et
 * on mesure l'écart. C'est le seul moyen sans bibliothèque de connaître le
 * décalage réel d'un jour donné : celui d'aujourd'hui ne vaut pas pour
 * février.
 */
export function decalageMinutes(instant: Date, fuseau: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: fuseau,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = Number(x.value);
  // `hour12: false` rend parfois 24 pour minuit : Date.UTC le reporte au
  // lendemain, ce qui fausserait le décalage d'exactement une journée.
  const heure = p.hour === 24 ? 0 : p.hour!;

  const commeUTC = Date.UTC(p.year!, p.month! - 1, p.day!, heure, p.minute!, p.second!);
  return Math.round((commeUTC - instant.getTime()) / 60_000);
}

/**
 * L'instant où il sera telle heure murale, tel jour, dans tel fuseau.
 *
 * Deux passes, et c'est nécessaire : le décalage à appliquer dépend de
 * l'instant qu'on cherche, et l'instant dépend du décalage. La première passe
 * donne une approximation, la seconde la corrige : ce qui compte le dernier
 * dimanche d'octobre, quand une même heure murale existe deux fois.
 */
export function instantLocal(
  annee: number, mois: number, jour: number,
  heure: number, minute: number,
  fuseau: string,
): Date {
  const murale = Date.UTC(annee, mois - 1, jour, heure, minute, 0);
  let t = murale - decalageMinutes(new Date(murale), fuseau) * 60_000;
  t = murale - decalageMinutes(new Date(t), fuseau) * 60_000;
  return new Date(t);
}

/** La date murale d'un instant dans un fuseau : année, mois, jour, et jour de semaine. */
export function dateLocale(
  instant: Date,
  fuseau: string,
): { annee: number; mois: number; jour: number; jourSemaine: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(instant);

  const p: Record<string, string> = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = x.value;

  const SEMAINE = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    annee: Number(p.year),
    mois: Number(p.month),
    jour: Number(p.day),
    jourSemaine: SEMAINE.indexOf(p.weekday!),
  };
}

/**
 * Le prochain départ d'une scène, strictement après `depuis`.
 *
 * Rend `null` pour une scène manuelle, ou dont aucun jour n'est coché.
 * On explore huit jours plutôt que sept : le jour en cours peut être déjà
 * passé, et il faut pouvoir retomber dessus la semaine suivante.
 */
export function prochaineOccurrence(
  trigger: SceneTrigger,
  depuis: Date,
  fuseau: string,
): Date | null {
  if (trigger.kind !== 'time') return null;
  if (!trigger.days?.length) return null;

  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trigger.at);
  if (!m) return null;
  const heure = Number(m[1]);
  const minute = Number(m[2]);

  // On avance de jours MURAUX, pas de tranches de 24 heures : la nuit du
  // passage à l'heure d'été ne dure que 23 heures, et « 23:30 + 24 h »
  // sauterait alors le dimanche entier. On part de midi du jour courant,
  // heure qui existe toujours, et on laisse Date.UTC déborder les mois.
  const depart = dateLocale(depuis, fuseau);
  for (let d = 0; d < 8; d++) {
    const midi = new Date(Date.UTC(depart.annee, depart.mois - 1, depart.jour + d, 12, 0, 0));
    const { annee, mois, jour, jourSemaine } = dateLocale(midi, 'UTC');
    if (!trigger.days.includes(jourSemaine)) continue;

    const instant = instantLocal(annee, mois, jour, heure, minute, fuseau);
    if (instant.getTime() > depuis.getTime()) return instant;
  }
  return null;
}

// ------------------------------------------------------------- en français

/** Le déclencheur, tel qu'on le lirait à voix haute. */
export function decrireTrigger(trigger: SceneTrigger): string {
  if (trigger.kind !== 'time') return 'À la demande';
  const jours = [...new Set(trigger.days)].sort((a, b) => a - b);

  if (jours.length === 7) return `Tous les jours à ${trigger.at}`;
  if (jours.length === 5 && jours.every((j) => j >= 1 && j <= 5))
    return `En semaine à ${trigger.at}`;
  if (jours.length === 2 && jours.includes(0) && jours.includes(6))
    return `Le week-end à ${trigger.at}`;
  if (jours.length === 1) return `Chaque ${JOURS_LONGS[jours[0]!]} à ${trigger.at}`;

  const noms = jours.map((j) => JOURS_LONGS[j]);
  const dernier = noms.pop();
  return `${noms.join(', ')} et ${dernier} à ${trigger.at}`;
}

/** La condition, en français. `nomEquipement` évite d'afficher un identifiant. */
export function decrireCondition(
  condition: SceneCondition,
  nomEquipement?: string,
): string {
  if (condition.kind !== 'device') return 'Sans condition';
  const quoi = nomEquipement ?? condition.deviceId;
  return condition.is === 'on' ? `Si « ${quoi} » est allumé` : `Si « ${quoi} » est éteint`;
}

/** Un retard, en français court : « tout de suite », « après 30 s », « après 2 min ». */
export function decrireRetard(secondes: number | undefined): string {
  const s = secondes ?? 0;
  if (s <= 0) return 'tout de suite';
  if (s < 60) return `après ${s} s`;
  const min = Math.round(s / 60);
  return `après ${min} min`;
}
