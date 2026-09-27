/**
 * Une camera factice, pour voir l'ecran Cameras fonctionner sans materiel.
 *
 * Elle se comporte comme une vraie camera IP bon marche :
 *   · elle sert une image sur /snapshot ;
 *   · elle peut exiger une authentification « basic » ;
 *   · elle sert sa page web a la racine, ce qui est l'erreur la plus frequente
 *     quand on recopie une adresse ;
 *   · elle sait tomber en panne sur commande.
 *
 * L'image porte l'heure a la seconde et une barre qui se deplace : on voit donc
 * a l'oeil nu que le rafraichissement marche, ce qu'une image fixe ne
 * prouverait pas.
 *
 *   node scripts/camera-factice.mjs
 *   node scripts/camera-factice.mjs --port 18871 --nom Jardin --user romain --pass secret
 */
import { createServer } from 'node:http';

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const PORT = Number(arg('port', 18870));
const NOM = arg('nom', 'Entrée');
const USER = arg('user', '');
const PASS = arg('pass', '');

/** En panne tant que ce drapeau est leve : bascule par /panne. */
let panne = false;

/**
 * L'image.
 *
 * Du SVG plutot qu'un JPEG : un vrai JPEG anime demanderait un encodeur, et ce
 * qu'on veut prouver ici c'est la CHAINE — le serveur va chercher l'image, la
 * relaie, le navigateur l'affiche puis la redemande. Le relais accepte tout ce
 * qui commence par `image/`, donc le SVG emprunte exactement le meme chemin
 * qu'un JPEG de vraie camera.
 */
function image() {
  const d = new Date();
  const heure = d.toLocaleTimeString('fr-FR');
  // La barre avance d'un seizieme par seconde : le mouvement se voit.
  const x = 40 + ((d.getSeconds() % 16) / 16) * 800;

  const lignes = Array.from(
    { length: 11 },
    (_, i) => `<line x1="0" y1="${i * 54}" x2="960" y2="${i * 54}"/>`,
  ).join('');
  const colonnes = Array.from(
    { length: 17 },
    (_, i) => `<line x1="${i * 60}" y1="0" x2="${i * 60}" y2="540"/>`,
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#1c1815"/>
  <g stroke="#2e2822" stroke-width="1">${lignes}${colonnes}</g>
  <rect x="${x}" y="200" width="80" height="140" rx="10" fill="#c87819" opacity="0.85"/>
  <text x="40" y="80" fill="#faf9f5" font-family="system-ui, sans-serif" font-size="42" font-weight="600">${NOM}</text>
  <text x="40" y="130" fill="#9a9388" font-family="ui-monospace, monospace" font-size="26">caméra factice · port ${PORT}</text>
  <text x="40" y="500" fill="#faf9f5" font-family="ui-monospace, monospace" font-size="56">${heure}</text>
</svg>`;
}

const serveur = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/panne') {
    panne = !panne;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(panne ? 'La caméra est maintenant en panne.\n' : 'La caméra refonctionne.\n');
    console.log(panne ? '  → en panne' : '  → rétablie');
    return;
  }

  if (url.pathname === '/snapshot') {
    if (panne) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('erreur interne');
      return;
    }
    if (USER) {
      const attendu = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
      if (req.headers.authorization !== attendu) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="camera"' }).end('unauthorized');
        return;
      }
    }
    const corps = image();
    res.writeHead(200, {
      'content-type': 'image/svg+xml',
      'content-length': Buffer.byteLength(corps),
      'cache-control': 'no-store',
    });
    res.end(corps);
    return;
  }

  // La racine sert la page web de la camera : c'est ce qu'on obtient quand on
  // recopie l'adresse de la barre du navigateur au lieu de celle de
  // l'instantane. L'ecran Cameras doit le dire clairement.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h1>Interface de la caméra ${NOM}</h1>
  <p>L'instantané est sur <code>/snapshot</code>.</p></body></html>`);
});

serveur.listen(PORT, () => {
  console.log(`\nCaméra factice « ${NOM} » sur http://127.0.0.1:${PORT}`);
  console.log(`  instantané   http://127.0.0.1:${PORT}/snapshot`);
  if (USER) console.log(`  identifiants ${USER} / ${PASS}`);
  console.log(`  page web     http://127.0.0.1:${PORT}/        (pour voir le message d'erreur)`);
  console.log(`  panne        curl http://127.0.0.1:${PORT}/panne   (bascule)\n`);
  console.log('Ctrl+C pour arrêter.\n');
});
