/**
 * Le chiffrement et les jetons.
 *
 * Tout vient de `node:crypto`. Aucune dépendance ajoutée : `bcrypt` et
 * `argon2` sont des modules natifs à recompiler pour l'architecture du
 * Raspberry Pi, alors que `scrypt` : présent dans Node depuis la version 10 : * appartient à la même famille et répond au même besoin. Une dépendance de
 * moins à surveiller sur une machine qui doit tourner des années sans qu'on y
 * touche.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  mdp: string | Buffer,
  sel: string | Buffer,
  longueur: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// --------------------------------------------------------------- le hachage

/**
 * Les paramètres de coût.
 *
 * N = 16384 demande 16 Mo de mémoire et quelques dizaines de millisecondes sur
 * un Raspberry Pi 5. C'est le bon compromis : imperceptible pour qui se
 * connecte, et assez lent pour qu'essayer des millions de mots de passe
 * devienne absurde. Monter à 32768 doublerait les deux : à reconsidérer le
 * jour où la machine change.
 *
 * Ces trois nombres sont écrits DANS la chaîne stockée, pas seulement ici :
 * le jour où on les augmente, les anciens mots de passe doivent continuer de
 * se vérifier avec les paramètres qui ont servi à les créer.
 */
const N = 16384;
const R = 8;
const P = 1;
const LONGUEUR = 64;

/** `scrypt$N$r$p$sel$empreinte`, sel et empreinte en base64. */
export async function hacher(motDePasse: string): Promise<string> {
  const sel = randomBytes(16);
  const empreinte = await scrypt(motDePasse.normalize('NFKC'), sel, LONGUEUR, { N, r: R, p: P });
  return ['scrypt', N, R, P, sel.toString('base64'), empreinte.toString('base64')].join('$');
}

/**
 * Vrai si le mot de passe correspond.
 *
 * Ne lève jamais : une chaîne stockée abîmée : base corrompue, migration
 * ratée : doit refuser la connexion, pas faire tomber le serveur et avec lui
 * toute la maison.
 */
export async function verifier(motDePasse: string, stocke: string): Promise<boolean> {
  try {
    const [algo, n, r, p, sel, empreinte] = stocke.split('$');
    if (algo !== 'scrypt' || !sel || !empreinte) return false;

    const attendu = Buffer.from(empreinte, 'base64');
    const calcule = await scrypt(
      motDePasse.normalize('NFKC'),
      Buffer.from(sel, 'base64'),
      attendu.length,
      { N: Number(n), r: Number(r), p: Number(p) },
    );

    // Comparaison à temps constant : une comparaison ordinaire s'arrête au
    // premier octet différent, et la durée de l'échec trahit alors combien
    // d'octets étaient justes.
    return calcule.length === attendu.length && timingSafeEqual(calcule, attendu);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- les jetons

/** 32 octets de hasard, en base64url : ce que le navigateur gardera en cookie. */
export function nouveauJeton(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Ce qu'on range en base à la place du jeton.
 *
 * Le jeton lui-même n'est jamais stocké : si quelqu'un met la main sur le
 * fichier SQLite : sauvegarde oubliée sur une clé, disque du Pi revendu : il
 * n'y trouve pas de quoi ouvrir une session. SHA-256 suffit ici, contrairement
 * aux mots de passe : un jeton de 32 octets aléatoires ne se devine pas, il
 * n'y a donc rien à ralentir.
 */
export function empreinteJeton(jeton: string): string {
  return createHash('sha256').update(jeton).digest('hex');
}

export function nouvelId(prefixe: string): string {
  return `${prefixe}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ------------------------------------------------------------- les appareils

/**
 * Un nom d'appareil lisible, tiré de l'en-tête du navigateur.
 *
 * Sert uniquement à se reconnaître dans la liste de ses sessions : « celle-là
 * c'est mon téléphone, je peux la fermer ». Volontairement grossier : on ne
 * cherche pas à identifier qui que ce soit, juste à aider à choisir.
 */
export function nommerAppareil(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Appareil inconnu';

  const machine = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;

  // L'ordre compte : Chrome et Edge se présentent tous deux comme Safari,
  // et Edge se présente aussi comme Chrome.
  // Les scripts de verification d'abord : ils se nomment explicitement, et on
  // veut les reconnaitre au premier coup d'oeil dans la liste des appareils.
  if (/LaRucheVerification/.test(ua)) return 'Script de vérification';

  const navigateur = /Maison|DomoKit/.test(ua)
    ? 'La Ruche'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;

  if (navigateur && machine) return `${navigateur} sur ${machine}`;
  return navigateur ?? machine ?? 'Appareil inconnu';
}

// ----------------------------------------------------------- la force brute

/**
 * Le guichet : il ralentit celui qui essaie des mots de passe au hasard.
 *
 * Sans lui, douze caractères ne servent à rien face à une machine qui en teste
 * mille par seconde sur le réseau local. On compte les échecs par identifiant
 * ET par adresse, pour qu'essayer dix comptes différents depuis la même
 * machine ne contourne pas la limite.
 *
 * En mémoire volontairement : un redémarrage du serveur efface les compteurs,
 * ce qui est sans conséquence : redémarrer prend plus de temps que d'attendre
 * le déblocage, et l'attaquant n'a aucun moyen de le provoquer.
 */
const SEUIL = 5;
const BLOCAGE_MS = 15 * 60 * 1000;
const FENETRE_MS = 15 * 60 * 1000;

interface Compteur {
  echecs: number;
  depuis: number;
  bloqueJusqua: number;
}

export class Guichet {
  private compteurs = new Map<string, Compteur>();

  /** Minutes restantes avant de pouvoir réessayer, ou 0 si la voie est libre. */
  attente(cles: string[]): number {
    const now = Date.now();
    let max = 0;
    for (const cle of cles) {
      const c = this.compteurs.get(cle);
      if (c && c.bloqueJusqua > now) max = Math.max(max, c.bloqueJusqua - now);
    }
    return Math.ceil(max / 60_000);
  }

  echec(cles: string[]): void {
    const now = Date.now();
    for (const cle of cles) {
      const c = this.compteurs.get(cle);
      // La fenêtre glisse : cinq échecs étalés sur la journée sont des oublis,
      // pas une attaque. Seuls cinq échecs rapprochés bloquent.
      if (!c || now - c.depuis > FENETRE_MS) {
        this.compteurs.set(cle, { echecs: 1, depuis: now, bloqueJusqua: 0 });
        continue;
      }
      c.echecs += 1;
      if (c.echecs >= SEUIL) {
        c.bloqueJusqua = now + BLOCAGE_MS;
        c.echecs = 0;
        c.depuis = now;
      }
    }
    this.nettoyer(now);
  }

  succes(cles: string[]): void {
    for (const cle of cles) this.compteurs.delete(cle);
  }

  /** Une table qui ne se vide jamais est une fuite de mémoire à retardement. */
  private nettoyer(now: number): void {
    if (this.compteurs.size < 1000) return;
    for (const [cle, c] of this.compteurs)
      if (c.bloqueJusqua < now && now - c.depuis > FENETRE_MS) this.compteurs.delete(cle);
  }
}

// ---------------------------------------------------------------- le cookie

export const COOKIE = 'ruche_session';

/** Trente jours. Se reconnecter chaque semaine sur son propre mur, non. */
export const SESSION_JOURS = 30;

/**
 * L'en-tête `Set-Cookie`, écrit à la main.
 *
 * `@fastify/cookie` n'est pas installé, et pour deux cookies : la pose et le
 * retrait : la dépendance ne se justifie pas.
 *
 * `Secure` n'est posé QU'EN HTTPS : la maison tourne en HTTP sur le réseau
 * local, et un cookie marqué `Secure` n'y serait jamais renvoyé : la connexion
 * paraîtrait réussir, puis échouer à la requête suivante.
 */
export function poserCookie(jeton: string, securise: boolean, rester = true): string {
  const parts = [`${COOKIE}=${jeton}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  // Sans `Max-Age`, le cookie meurt a la fermeture du navigateur : c'est ce
  // qu'on veut sur un appareil qu'on n'est pas seul a utiliser. La session
  // reste ouverte cote serveur : simplement, ce navigateur-la ne la rapporte
  // plus, et elle s'eteindra d'elle-meme a l'expiration.
  if (rester) parts.push(`Max-Age=${SESSION_JOURS * 24 * 3600}`);
  if (securise) parts.push('Secure');
  return parts.join('; ');
}

export function retirerCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Le jeton de la requête : en-tête `Authorization` d'abord, cookie ensuite.
 *
 * Les deux, parce que le navigateur renvoie naturellement un cookie, alors
 * qu'une application native a plus simple de porter un en-tête.
 */
export function jetonDeLaRequete(
  cookieHeader: string | undefined,
  authHeader: string | undefined,
): string | null {
  if (authHeader?.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  for (const morceau of (cookieHeader ?? '').split(';')) {
    const [nom, ...reste] = morceau.trim().split('=');
    if (nom === COOKIE && reste.length) return reste.join('=');
  }
  return null;
}
