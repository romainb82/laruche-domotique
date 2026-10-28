/**
 * La couche HTTP de l'interface, en un seul endroit.
 *
 * Avant, une vingtaine de `fetch` nus vivaient dans les vues, chacun avec sa
 * façon (ou son absence de façon) de traiter le 401, le JSON cassé et le
 * serveur qui ne répond pas. Trois conséquences qu'on a vues : une session
 * expirée affichée comme « Aucune caméra déclarée », un `undefined
 * équipements` en vert, et des requêtes qui attendent pour toujours.
 *
 * Ici : un délai d'attente sur chaque appel, le 401 qui ramène à la page de
 * connexion, et une erreur toujours porteuse d'un message en français.
 */

export class ErreurHttp extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly corps: unknown = null,
  ) {
    super(message);
  }
}

const DELAI_MS = 8_000;

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Délai d'attente, pour les appels qu'on sait lents (essai d'une connexion). */
  delaiMs?: number;
}

/**
 * Un appel à l'API. Rend le corps JSON décodé, ou lève une `ErreurHttp`.
 *
 * Un 401 déclenche le retour à la page de connexion AVANT de lever : la vue
 * qui appelait n'a rien à faire de particulier, elle sera démontée.
 */
export async function http<T = unknown>(url: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, delaiMs = DELAI_MS } = options;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(delaiMs),
    });
  } catch (e) {
    const expire = (e as Error).name === 'TimeoutError';
    throw new ErreurHttp(
      expire ? 'La maison met trop de temps à répondre.' : 'La maison ne répond pas.',
      0,
    );
  }

  const corps: unknown = await res.json().catch(() => null);

  if (res.status === 401) {
    await retourConnexion();
    throw new ErreurHttp('Connexion requise.', 401, corps);
  }
  if (!res.ok) {
    throw new ErreurHttp(messageDe(corps) ?? `Erreur ${res.status}`, res.status, corps);
  }
  return corps as T;
}

/** Le message d'erreur que le serveur a pu mettre dans le corps. */
export function messageDe(corps: unknown): string | null {
  if (!corps || typeof corps !== 'object') return null;
  const o = corps as { error?: unknown; issues?: Array<{ message?: string }> };
  if (typeof o.error === 'string') return o.error;
  if (Array.isArray(o.issues) && o.issues.length)
    return o.issues.map((i) => i.message).filter(Boolean).join('\n');
  return null;
}

/**
 * Une session expirée ramène à la page de connexion.
 *
 * Sans ça, une session qui meurt pendant la nuit afficherait « serveur
 * injoignable » au réveil, alors que le serveur va parfaitement bien et qu'il
 * suffit de retaper son mot de passe.
 *
 * Les imports sont faits ICI et pas en tête de fichier, volontairement : les
 * magasins s'importent les uns les autres, et deux modules qui s'importent
 * mutuellement au chargement ne s'initialisent pas toujours dans l'ordre
 * qu'on croit.
 */
let retourEnCours: Promise<void> | null = null;
async function retourConnexion(): Promise<void> {
  if (retourEnCours) return retourEnCours;
  retourEnCours = (async () => {
    const [{ useAuth }, { useHouse }, { router }] = await Promise.all([
      import('@/stores/auth'),
      import('@/stores/house'),
      import('@/router'),
    ]);
    useAuth().expiree();
    useHouse().disconnect();
    const ou = router.currentRoute.value.fullPath;
    if (ou !== '/connexion')
      await router.replace({ path: '/connexion', query: ou === '/' ? {} : { redirect: ou } });
  })().finally(() => {
    retourEnCours = null;
  });
  return retourEnCours;
}
