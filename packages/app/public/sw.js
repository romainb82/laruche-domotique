/*
 * Le service worker de La Ruche.
 *
 * RÈGLE D'OR, non négociable : l'état vient toujours du matériel. Rien de ce
 * qui touche `/api` ou `/ws` n'est mis en cache, jamais. Un volet affiché à
 * 40 % parce que c'était sa position il y a une heure est exactement le
 * mensonge que cette application s'interdit. Mieux vaut un écran qui dit
 * « injoignable » qu'un écran qui a l'air juste et ne l'est pas.
 *
 * Ce qui EST mis en cache : la coquille. Le HTML, le JavaScript et le CSS
 * produits par Vite. Leurs noms portent une empreinte de contenu, donc un
 * fichier donné ne change jamais : le cache d'abord est non seulement sûr,
 * c'est la bonne stratégie.
 *
 * Ce que ça apporte vraiment : l'application s'ouvre instantanément, même sur
 * un Wi-Fi lent, et affiche une page honnête quand la maison ne répond pas au
 * lieu de l'erreur du navigateur. Ça ne la rend pas utilisable hors ligne :
 * sans le serveur, il n'y a rien à piloter.
 */

const VERSION = 'ruche-v1';
const COQUILLE = `${VERSION}-coquille`;

/** Ce qu'on garde sous la main dès l'installation. Le reste se met en cache
 *  au fil des visites : les morceaux de route sont chargés à la demande. */
const AMORCE = ['/', '/manifest.webmanifest', '/icone-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(COQUILLE).then((c) => c.addAll(AMORCE)));
  // Pas de `skipWaiting` : prendre la main pendant qu'un onglet tourne peut
  // supprimer un morceau de route que Vue n'a pas encore chargé, et la
  // navigation suivante échoue. La nouvelle version prend le relais à la
  // prochaine ouverture complète.
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((noms) => Promise.all(noms.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** La page affichée quand la maison ne répond pas et qu'on n'a rien en cache. */
const INJOIGNABLE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>La Ruche, injoignable</title>
<style>
  body{margin:0;min-height:100dvh;display:grid;place-items:center;
       background:#FAF7F3;color:#1C1815;
       font:16px/1.6 system-ui,-apple-system,sans-serif;padding:24px}
  div{max-width:34ch;text-align:center}
  h1{font-size:21px;margin:0 0 10px}
  p{margin:0;color:#746C64;font-size:15px}
  button{margin-top:22px;border:0;border-radius:999px;background:#96560C;color:#fff;
         padding:13px 26px;font:inherit;font-weight:600;cursor:pointer}
</style></head>
<body><div>
  <h1>La maison ne répond pas</h1>
  <p>Le serveur est injoignable. Vérifiez qu'il tourne et que ce téléphone est
     bien sur le réseau de la maison.</p>
  <button onclick="location.reload()">Réessayer</button>
</div></body></html>`;

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Jamais le même domaine ? On laisse passer : images de caméras tierces,
  // rien à intercepter.
  if (url.origin !== self.location.origin) return;

  // L'état de la maison, en direct et uniquement en direct.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Une navigation : on tente le réseau, et on retombe sur la coquille en
  // cache. C'est ce qui permet d'ouvrir /energie directement hors ligne.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((r) => {
          // Seule une VRAIE coquille se garde : un 502 de tunnel mis en cache
          // afficherait une page d'erreur hors ligne pour toujours.
          if (r.ok) {
            const copie = r.clone();
            caches.open(COQUILLE).then((c) => c.put('/', copie));
          }
          return r;
        })
        .catch(async () => {
          const cache = await caches.open(COQUILLE);
          return (
            (await cache.match('/')) ??
            new Response(INJOIGNABLE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          );
        }),
    );
    return;
  }

  // Le reste : des fichiers au nom empreinté, donc immuables. Cache d'abord.
  e.respondWith(
    caches.match(request).then(
      (enCache) =>
        enCache ??
        fetch(request).then((r) => {
          if (r.ok && r.type === 'basic') {
            const copie = r.clone();
            caches.open(COQUILLE).then((c) => c.put(request, copie));
          }
          return r;
        }),
    ),
  );
});
