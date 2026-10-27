/**
 * Les équipements épinglés sur l'accueil.
 *
 * C'est une préférence D'APPAREIL, pas un état de la maison : ce que Romain
 * épingle sur son téléphone n'a aucune raison de s'imposer à Mélissa sur le
 * sien. D'où `localStorage` plutôt que la configuration du serveur.
 *
 * Conséquence assumée : vider les données du navigateur efface la sélection.
 * C'est sans gravité : il n'y a rien là qu'on ne puisse refaire en dix
 * secondes, et rien qui engage la maison.
 *
 * Tout accès est protégé : en navigation privée, ou avec les données de site
 * bloquées, la simple lecture de `localStorage` lève une exception. Une liste
 * d'épinglés ne doit jamais empêcher l'accueil de s'afficher.
 */
import { ref, watch } from 'vue';
import type { DeviceConfig } from '@domo/shared';

const CLE = 'ruche.epingles';

/**
 * La sélection de départ : ce qu'on touche vraiment tous les jours.
 *
 * Six, pas douze : une rangée d'épinglés qui déborde ne rend plus le service
 * qu'on lui demande, celui d'avoir l'essentiel sous la main sans chercher.
 * Le choix suit la journée : on rentre (entrée), on cuisine, on s'installe au
 * salon, on ferme la véranda le soir, on monte se coucher. La terrasse est là
 * parce qu'une lumière extérieure s'allume depuis l'intérieur, toujours.
 *
 * Désigné par pièce et par suffixe plutôt que par identifiant complet : si le
 * format des identifiants change un jour, la sélection survit.
 */
export const DEFAUTS: readonly { zone: string; slug: string }[] = [
  { zone: 'z04', slug: 'plafond' }, // Entrée : le premier geste en rentrant
  { zone: 'z01', slug: 'plafond' }, // Cuisine
  { zone: 'z03', slug: 'general' }, // Salon séjour : l'éclairage principal
  { zone: 'z03', slug: 'volet-veranda' }, // Salon séjour : le grand volet
  { zone: 'z07', slug: 'plafond' }, // Chambre 1
  { zone: 'z21', slug: 'terrasse' }, // Extérieur
];

/** Les identifiants réels correspondant aux défauts, ceux qui existent. */
export function resoudreDefauts(equipements: DeviceConfig[]): string[] {
  return DEFAUTS.map(
    (d) =>
      equipements.find((e) => e.zoneId === d.zone && e.id.endsWith(`.${d.slug}`))?.id,
  ).filter((id): id is string => Boolean(id));
}

/**
 * `null` = personne n'a encore choisi, on proposera les défauts.
 * `[]` = quelqu'un a tout décoché, et c'est un choix qu'on respecte. Confondre
 * les deux ferait réapparaître mes six tuiles à chaque rechargement.
 */
function lire(): string[] | null {
  try {
    const brut = localStorage.getItem(CLE);
    if (brut === null) return null;
    const v: unknown = JSON.parse(brut);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * Un seul état pour toute l'application : deux composants qui liraient chacun
 * le leur se désynchroniseraient au premier épinglage.
 */
const epingles = ref<string[] | null>(lire());

watch(epingles, (v) => {
  if (v === null) return;
  try {
    localStorage.setItem(CLE, JSON.stringify(v));
  } catch {
    /* quota plein ou stockage interdit : on garde la sélection en mémoire */
  }
});

export function useEpingles() {
  /** Fige une sélection : y compris vide, qui vaut « je n'en veux aucun ». */
  const fixer = (ids: string[]) => {
    epingles.value = ids;
  };

  return { epingles, fixer, resoudreDefauts };
}
