/**
 * Le relais de cameras, mis a l'epreuve contre une VRAIE camera.
 *
 * On monte une fausse camera qui se comporte comme les vraies : elle exige une
 * authentification « basic », elle sert du JPEG, et elle sait aussi renvoyer sa
 * page web quand on se trompe d'adresse : l'erreur la plus frequente, et celle
 * qui produit d'habitude un carre gris sans explication.
 *
 * Ce qui est verifie ici et nulle part ailleurs :
 *   · les identifiants de la camera ne sortent JAMAIS du serveur ;
 *   · une mauvaise adresse, un mauvais mot de passe et une camera muette
 *     donnent trois messages differents, en francais ;
 *   · une camera au repos ne se laisse pas interroger ;
 *   · allumer une camera est un avertissement, pas une erreur.
 */
import { createServer } from 'node:http';

import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
await ouvrirSession();

const B = 'http://localhost:3001';
const PORT = 18860;

const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const put = (u, b) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const post = (u, b) => j(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------- la fausse camera

/** Un JPEG d'un pixel : assez pour prouver que l'image traverse le relais. */
const PIXEL = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const journal = { entetes: [] };
let muette = false;

const camera = createServer((req, res) => {
  if (muette) return; // socket laissee ouverte : le cas « ne repond pas »

  if (req.url.startsWith('/snapshot')) {
    journal.entetes.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== 'Basic ' + Buffer.from('romain:secret').toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic' }).end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': PIXEL.length });
    res.end(PIXEL);
    return;
  }

  // L'erreur classique : on a copie l'adresse de la page web de la camera.
  res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Interface de la caméra</html>');
});

await new Promise((r) => camera.listen(PORT, r));
console.log(`fausse caméra sur ${PORT}\n`);

// ------------------------------------------------------------- configuration

const [, cfg0] = await j('/api/config');
const propre = {
  ...cfg0,
  connections: [{ id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} }],
  devices: cfg0.devices.filter((d) => !d.id.startsWith('test.')).map((d) => ({ ...d, binding: null })),
};

const entree = {
  id: 'test.cam.entree', label: 'Entrée', zoneId: 'z04', order: 0, enabled: true,
  snapshotUrl: `http://127.0.0.1:${PORT}/snapshot`,
  username: 'romain', password: 'secret', refreshSeconds: 2,
};
const repos = { ...entree, id: 'test.cam.repos', label: 'Garage', zoneId: '', order: 1, enabled: false };

// ------------------------------------------------- l'essai avant d'allumer

const [, essai] = await post('/api/cameras/test', entree);
ok(essai?.ok && essai.type?.startsWith('image/'),
   `Essai à blanc : ${essai?.ok ? `${essai.octets} octets de ${essai.type} en ${essai.ms} ms` : essai?.error}`);

const [, mauvaisMdp] = await post('/api/cameras/test', { ...entree, password: 'faux' });
ok(!mauvaisMdp?.ok && /identifiants/i.test(mauvaisMdp?.error ?? ''),
   `Mauvais mot de passe : « ${mauvaisMdp?.error} »`);

const [, mauvaiseUrl] = await post('/api/cameras/test', { ...entree, snapshotUrl: `http://127.0.0.1:${PORT}/` });
ok(!mauvaiseUrl?.ok && /page web/i.test(mauvaiseUrl?.error ?? ''),
   `Adresse de la page web au lieu de l'image : « ${mauvaiseUrl?.error} »`);

const [, morte] = await post('/api/cameras/test', { ...entree, snapshotUrl: 'http://127.0.0.1:18999/snap' });
ok(!morte?.ok && /refuse la connexion/i.test(morte?.error ?? ''),
   `Adresse morte : « ${morte?.error} »`);

// ------------------------------------------------------- une fois enregistrée

const [code, corps] = await put('/api/config', { ...propre, cameras: [entree, repos] });
ok(code === 200, 'Configuration acceptée avec deux caméras');
ok((corps?.warnings ?? []).some((w) => /caméra\(s\) active\(s\)/.test(w.message)),
   `Caméra active signalée, sans bloquer : « ${(corps?.warnings ?? []).find((w) => /active\(s\)/.test(w.message))?.message}` + ' »');
await pause(600);

// --- LES SECRETS ne sortent pas ---
const [, liste] = await j('/api/cameras');
const texte = JSON.stringify(liste);
ok(liste?.cameras?.length === 2, `${liste?.cameras?.length} caméras listées`);
ok(!texte.includes('secret') && !texte.includes('romain') && !texte.includes('127.0.0.1'),
   'Ni mot de passe, ni utilisateur, ni adresse dans ce que reçoit le navigateur');
ok(liste?.cameras?.[0]?.protegee === true,
   'Mais l’interface sait que la caméra est protégée par des identifiants');

// --- L'IMAGE traverse le relais ---
const img = await fetch(`${B}/api/cameras/test.cam.entree/snapshot`);
const octets = Buffer.from(await img.arrayBuffer());
ok(img.status === 200 && img.headers.get('content-type')?.startsWith('image/'),
   `Image relayée : ${img.status}, ${img.headers.get('content-type')}, ${octets.length} octets`);
ok(octets.equals(PIXEL), 'Les octets reçus sont exactement ceux de la caméra');
ok(/no-store/.test(img.headers.get('cache-control') ?? ''),
   `Pas de mise en cache : « ${img.headers.get('cache-control')} »`);
ok(journal.entetes.every((e) => e && e.startsWith('Basic ')),
   'La caméra a bien reçu l’authentification à chaque appel');

// --- UNE CAMERA AU REPOS ne se laisse pas interroger ---
const [, refus] = await j('/api/cameras/test.cam.repos/snapshot');
ok(refus?.ok === false && /éteinte/i.test(refus?.error ?? ''),
   `Caméra au repos : « ${refus?.error} »`);

// --- UNE CAMERA INCONNUE rend 404, pas une erreur technique ---
const inconnue = await fetch(`${B}/api/cameras/nexiste.pas/snapshot`);
ok(inconnue.status === 404, `Caméra inconnue : ${inconnue.status}`);

// --- UNE CAMERA MUETTE ne fait pas attendre indéfiniment ---
muette = true;
const debut = Date.now();
const [, silence] = await j('/api/cameras/test.cam.entree/snapshot');
const attendu = Date.now() - debut;
ok(/ne répond pas/i.test(silence?.error ?? '') && attendu < 10_000,
   `Silence coupé après ${(attendu / 1000).toFixed(1)} s : « ${silence?.error} »`);
muette = false;

// --- LA VALIDATION refuse une caméra allumée sans adresse ---
const [codeVide] = await put('/api/config', {
  ...propre, cameras: [{ ...entree, id: 'test.cam.vide', snapshotUrl: '' }],
});
ok(codeVide === 400, 'Une caméra active sans adresse d’image est refusée');

// ------------------------------------------------------------------ ménage

await put('/api/config', { ...propre, cameras: [] });
await pause(400);
camera.close();
process.exit(process.exitCode ?? 0);
