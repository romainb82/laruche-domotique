/**
 * Les comptes de la maison.
 *
 * Jusqu'ici le serveur n'avait aucune authentification : toute machine du
 * réseau local pouvait piloter la maison et demander les images des caméras.
 * Pour des lampes c'était sans conséquence, pour une caméra d'intérieur, non.
 *
 * Ce module ne contient que le VOCABULAIRE et les RÈGLES : pas de chiffrement,
 * pas d'accès à la base. Le serveur les applique, l'interface les affiche, et
 * les deux disent donc exactement la même chose à la personne qui tape son mot
 * de passe. Un message de refus écrit à deux endroits finit toujours par
 * diverger.
 */

// ------------------------------------------------------------------- les rôles

/**
 * Trois rôles, pas davantage. Une maison n'est pas une entreprise : au-delà de
 * trois, personne ne sait plus dire qui a le droit de quoi, et c'est ainsi
 * qu'on finit par tout donner à tout le monde « pour que ça marche ».
 */
export type Role = 'admin' | 'habitant' | 'invite';

export const ROLES: readonly Role[] = ['admin', 'habitant', 'invite'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  habitant: 'Habitant',
  invite: 'Invité',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Pilote la maison, et peut modifier le matériel, les scénarios et les comptes.',
  habitant: 'Pilote la maison et voit les caméras. Ne touche ni au matériel ni aux comptes.',
  invite: 'Allume les lumières et ouvre les volets. Ne voit pas les caméras.',
};

/**
 * Le rang d'un rôle. Un rôle donne accès à tout ce qu'autorisent les rangs
 * inférieurs : c'est ce qui permet d'écrire « cette route exige au moins
 * `habitant` » plutôt que d'énumérer les rôles un par un à chaque route.
 */
const RANG: Record<Role, number> = { invite: 1, habitant: 2, admin: 3 };

export function auMoins(role: Role, minimum: Role): boolean {
  return RANG[role] >= RANG[minimum];
}

// ---------------------------------------------------------------- les comptes

export interface Compte {
  id: string;
  /** Ce qu'on tape pour se connecter. Minuscules, sans espace. */
  identifiant: string;
  /** Ce qu'on affiche dans l'interface : « Romain », « Mélissa ». */
  nom: string;
  role: Role;
  /** ISO 8601, UTC, comme tous les horodatages du projet. */
  creeLe: string;
  derniereConnexion: string | null;
  actif: boolean;
}

/**
 * Une session ouverte, telle que l'interface a le droit de la voir.
 *
 * Le jeton n'y figure pas : il ne sort du serveur qu'une seule fois, dans le
 * cookie, au moment de la connexion. Ce qu'on liste ici sert à reconnaître ses
 * propres appareils pour en fermer un à distance.
 */
export interface SessionPublique {
  id: string;
  appareil: string;
  creeLe: string;
  vueLe: string;
  /** Vrai pour la session qui consulte la liste : on ne ferme pas la sienne par mégarde. */
  courante: boolean;
}

// --------------------------------------------------------------- les règles

export const IDENTIFIANT_MIN = 3;
export const IDENTIFIANT_MAX = 32;

/**
 * Minuscules, chiffres, point, tiret, souligné.
 *
 * Pas d'accents ni de majuscules : « Mélissa » et « melissa » doivent être la
 * même personne, et personne ne se souvient le lendemain matin s'il avait mis
 * l'accent. Le vrai prénom vit dans `nom`, qui lui accepte tout.
 */
const IDENTIFIANT_VALIDE = /^[a-z0-9][a-z0-9._-]*$/;

export function normaliserIdentifiant(brut: string): string {
  return brut.trim().toLowerCase();
}

/** `null` si l'identifiant convient, sinon la raison, écrite pour un humain. */
export function validerIdentifiant(brut: string): string | null {
  const id = normaliserIdentifiant(brut);
  if (!id) return 'Il faut un identifiant.';
  if (id.length < IDENTIFIANT_MIN) return `Au moins ${IDENTIFIANT_MIN} caractères.`;
  if (id.length > IDENTIFIANT_MAX) return `${IDENTIFIANT_MAX} caractères au maximum.`;
  if (!IDENTIFIANT_VALIDE.test(id))
    return 'Lettres sans accent, chiffres, point, tiret ou souligné, en commençant par une lettre ou un chiffre.';
  return null;
}

/**
 * Douze caractères minimum, et rien d'autre.
 *
 * Pas de « une majuscule, un chiffre, un symbole » : cette règle-là produit
 * `Maison2024!` partout, qui est devinable, et pousse les gens à écrire leur
 * mot de passe sur un papier. La longueur est ce qui protège réellement, et
 * c'est aussi la recommandation du NIST depuis 2017.
 */
export const MOT_DE_PASSE_MIN = 12;
export const MOT_DE_PASSE_MAX = 200;

/**
 * Les mots de passe qu'un voisin essaierait en premier. La liste est courte et
 * volontairement locale : une vraie liste de millions d'entrées n'a pas sa
 * place sur un Raspberry Pi, et la longueur minimale fait le gros du travail.
 */
const TROP_EVIDENTS = [
  'motdepasse',
  'password',
  'azertyuiop',
  'qwertyuiop',
  '123456789012',
  'laruche',
  'domotique',
  'maisonmaison',
];

export function validerMotDePasse(mdp: string, identifiant = ''): string | null {
  if (!mdp) return 'Il faut un mot de passe.';
  if (mdp.length < MOT_DE_PASSE_MIN)
    return `Au moins ${MOT_DE_PASSE_MIN} caractères. Une phrase courte fait un très bon mot de passe.`;
  if (mdp.length > MOT_DE_PASSE_MAX) return `${MOT_DE_PASSE_MAX} caractères au maximum.`;

  const plat = mdp.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (TROP_EVIDENTS.some((t) => plat.includes(t)))
    return 'Celui-ci serait deviné en quelques essais. Prenez autre chose.';

  const id = normaliserIdentifiant(identifiant);
  if (id.length >= IDENTIFIANT_MIN && plat.includes(id))
    return "Le mot de passe ne doit pas contenir l'identifiant.";

  // Un seul caractère répété atteint la longueur sans rien protéger.
  if (new Set(mdp).size < 5) return 'Trop répétitif. Variez les caractères.';

  return null;
}

export function validerNom(brut: string): string | null {
  const nom = brut.trim();
  if (!nom) return 'Il faut un nom.';
  if (nom.length > 60) return '60 caractères au maximum.';
  return null;
}

// ------------------------------------------------------------- les messages

/**
 * Le refus de connexion, en une seule formule.
 *
 * Volontairement identique que l'identifiant soit inconnu ou le mot de passe
 * faux : distinguer les deux permettrait à n'importe qui de découvrir, essai
 * par essai, quels comptes existent dans la maison.
 */
export const REFUS_CONNEXION = 'Identifiant ou mot de passe incorrect.';
