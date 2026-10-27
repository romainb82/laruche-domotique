import type { CameraConfig } from '@domo/shared';

/**
 * Les caméras, vues du serveur.
 *
 * Tout passe par ici, et c'est le point essentiel : **le navigateur ne parle
 * jamais à une caméra**. Il demande une image au serveur, qui va la chercher.
 *
 * Trois raisons, dans l'ordre.
 *
 * 1. Les identifiants de la caméra restent sur le serveur. Les mettre dans une
 *    balise `img` les inscrirait dans l'historique du navigateur, dans les
 *    journaux des équipements réseau, et dans le presse-papier de quiconque
 *    copie l'adresse.
 * 2. Le téléphone hors du réseau local n'a aucun moyen de joindre une caméra
 *    en 192.168. Le serveur, lui, est déjà joignable par le tunnel.
 * 3. Une caméra a rarement du HTTPS valide. Servir la page en HTTPS et l'image
 *    en HTTP ferait bloquer l'image par le navigateur.
 *
 * Ce qui n'est PAS fait ici : le flux vidéo continu. Il demande de transcoder
 * du RTSP, donc un ffmpeg permanent, donc un tout autre projet. Un instantané
 * rafraîchi suffit à voir qui sonne à la porte.
 */

/** Au-delà, on considère que la caméra ne répond pas. */
const DELAI_MS = 6_000;

/** Une image plus grosse que ça n'est pas un instantané de caméra. */
const TAILLE_MAX = 8 * 1024 * 1024;

export interface Image {
  corps: Buffer;
  type: string;
  ms: number;
}

/**
 * Va chercher l'image d'une caméra.
 *
 * Rejette avec un message en français : « 401 » n'apprend rien à qui a mal
 * tapé un mot de passe.
 */
export async function instantane(camera: CameraConfig): Promise<Image> {
  if (!camera.enabled) throw new Error(`« ${camera.label} » est éteinte.`);
  if (!/^https?:\/\//i.test(camera.snapshotUrl))
    throw new Error(`« ${camera.label} » n'a pas d'adresse d'image valide.`);

  const entetes: Record<string, string> = { accept: 'image/*' };
  if (camera.username) {
    // L'authentification « basic », que presque toutes les caméras acceptent.
    // Elle voyage en clair : sur un réseau local c'est l'usage, et la caméra
    // n'offre souvent rien d'autre.
    const jeton = Buffer.from(`${camera.username}:${camera.password}`).toString('base64');
    entetes.authorization = `Basic ${jeton}`;
  }

  const debut = Date.now();
  let res: Response;
  try {
    res = await fetch(camera.snapshotUrl, {
      headers: entetes,
      signal: AbortSignal.timeout(DELAI_MS),
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error(lisible(e as Error, camera));
  }

  if (res.status === 401 || res.status === 403)
    throw new Error(`« ${camera.label} » refuse ces identifiants.`);
  if (!res.ok) throw new Error(`« ${camera.label} » a répondu ${res.status}.`);

  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/'))
    throw new Error(
      `« ${camera.label} » a répondu du ${type || 'contenu inconnu'} au lieu d'une image. ` +
        "L'adresse pointe peut-être sur la page web de la caméra plutôt que sur son instantané.",
    );

  const corps = Buffer.from(await res.arrayBuffer());
  if (corps.length > TAILLE_MAX)
    throw new Error(`« ${camera.label} » a renvoyé ${Math.round(corps.length / 1024 / 1024)} Mo : ce n'est pas un instantané.`);
  if (!corps.length) throw new Error(`« ${camera.label} » a renvoyé une image vide.`);

  return { corps, type, ms: Date.now() - debut };
}

/**
 * Ce que l'interface a le droit de connaître.
 *
 * Ni mot de passe, ni adresse : l'adresse contient souvent le nom d'utilisateur
 * et la topologie du réseau, et l'interface n'en a aucun besoin puisqu'elle
 * demande l'image au serveur.
 */
export function publique(c: CameraConfig): {
  id: string; label: string; zoneId: string; order: number;
  enabled: boolean; refreshSeconds: number; protegee: boolean;
} {
  return {
    id: c.id,
    label: c.label,
    zoneId: c.zoneId,
    order: c.order,
    enabled: c.enabled,
    refreshSeconds: c.refreshSeconds,
    protegee: !!c.username,
  };
}

function lisible(e: Error, camera: CameraConfig): string {
  const enveloppe = e as Error & { errors?: Error[]; cause?: unknown };
  if (enveloppe.errors?.length) return lisible(enveloppe.errors[0]!, camera);
  if (enveloppe.cause instanceof Error) return lisible(enveloppe.cause, camera);

  const m = e.message || String(e);
  const quoi = `« ${camera.label} »`;
  if (e.name === 'TimeoutError' || m.includes('timeout')) return `${quoi} ne répond pas.`;
  if (m.includes('ECONNREFUSED')) return `${quoi} refuse la connexion.`;
  if (m.includes('ENOTFOUND') || m.includes('EAI_AGAIN')) return `${quoi} : adresse introuvable.`;
  if (m.includes('EHOSTUNREACH') || m.includes('ENETUNREACH')) return `${quoi} : réseau injoignable depuis le serveur.`;
  if (m.includes('certificate') || m.includes('SSL')) return `${quoi} : certificat refusé.`;
  // Node refuse d'emblée une poignée de ports réservés (1, 7, 9, 19…), avec un
  // « bad port » qui n'apprend rien à qui a mal recopié une adresse.
  if (m.includes('bad port')) return `${quoi} : ce numéro de port est interdit : vérifie l'adresse.`;
  return `${quoi} : ${m}`;
}
