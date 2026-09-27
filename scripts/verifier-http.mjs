/**
 * Le canal HTTP, mis a l'epreuve contre un VRAI serveur.
 *
 * On monte un faux regulateur de piscine — format volontairement penible :
 * temperature en dixiemes, pompe imbriquee, cle avec un tiret — et on verifie
 * que le meme moteur de transformation le comprend sans code specifique.
 *
 * On verifie aussi ce qui ne se voit pas : qu'une seule requete sert tous les
 * capteurs d'un meme point d'entree, et qu'une panne HTTP n'emporte pas le
 * reste de la maison.
 */
import { createServer } from 'node:http';

const B = 'http://localhost:3001';
const PORT = 18840;

const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const put = (u, b) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const post = (u, b) => j(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------- le faux materiel

/** L'etat du regulateur, que nos ecritures doivent reellement modifier. */
const regulateur = { ph: 7.42, orp: 690, temp_c_x10: 265, pompe: { 'en-marche': false } };
const journal = { requetes: 0, ecritures: [], entetes: [] };
let panne = false;

const materiel = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (panne) { res.writeHead(500).end('en panne'); return; }

  if (url.pathname === '/status') {
    journal.requetes++;
    journal.entetes.push(req.headers['x-cle-api'] ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(regulateur));
    return;
  }

  if (url.pathname === '/pompe' && req.method === 'POST') {
    let corps = '';
    req.on('data', (c) => (corps += c));
    req.on('end', () => {
      journal.ecritures.push(corps);
      try { regulateur.pompe['en-marche'] = JSON.parse(corps).on === true; } catch { /* ignoré */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(404).end();
});

await new Promise((r) => materiel.listen(PORT, r));
console.log(`regulateur de test sur ${PORT}\n`);

// ------------------------------------------------------------- configuration

const [, cfg0] = await j('/api/config');

/**
 * On repart d'une maison saine : les executions precedentes laissent des
 * raccordements vers des canaux que ce test ne declare pas, et la validation
 * — a juste titre — refuserait la configuration.
 */
const base = cfg0.devices
  .filter((d) => !d.id.startsWith('test.'))
  .map((d) => ({ ...d, binding: null }));

const connexions = [
  { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
  {
    id: 'piscine', kind: 'http', label: 'Régulateur piscine', enabled: true,
    settings: { baseUrl: `http://localhost:${PORT}`, headers: { 'x-cle-api': 'secret-42' }, pollSeconds: 2 },
  },
];

/** Trois capteurs et une pompe, tous sur le MÊME point d'entrée `/status`. */
const equipements = [
  {
    id: 'test.sensor.ph', zoneId: 'z20', label: 'pH bassin', type: 'sensor', metric: 'ph',
    order: 90, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'piscine',
      reads: [{ source: '/status', path: 'ph', into: 'sensor.value', pipeline: [{ op: 'number' }, { op: 'round', decimals: 2 }] }],
      writes: [] },
  },
  {
    id: 'test.sensor.orp', zoneId: 'z20', label: 'Redox bassin', type: 'sensor', metric: 'orp',
    order: 91, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'piscine',
      reads: [{ source: '/status', path: 'orp', into: 'sensor.value', pipeline: [{ op: 'number' }] }],
      writes: [] },
  },
  {
    // Dixièmes de degré : la mise à l'échelle est faite par la config, pas par du code.
    id: 'test.sensor.temp', zoneId: 'z20', label: 'Température eau', type: 'sensor', metric: 'temperature',
    order: 92, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'piscine',
      reads: [{ source: '/status', path: 'temp_c_x10', into: 'sensor.value',
                pipeline: [{ op: 'number' }, { op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] }],
      writes: [] },
  },
  {
    // Clé imbriquée ET contenant un tiret : le chemin doit savoir l'échapper.
    id: 'test.light.pompe', zoneId: 'z20', label: 'Pompe filtration', type: 'light',
    order: 93, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'piscine',
      reads: [{ source: '/status', path: "pompe['en-marche']", into: 'switch.state', pipeline: [{ op: 'bool', truthy: [] }] }],
      writes: [{ on: 'switch', target: '/pompe', payload: '{"on":{{valeur}}}', pipeline: [], method: 'POST' }] },
  },
];

// ------------------------------------------------------------------- essais

const [codeTest, essai] = await post('/api/connections/test', connexions[1]);
ok(codeTest === 200 && essai.ok, `Essai à blanc du canal HTTP : ${essai.ok ? `répond en ${essai.ms} ms` : essai.error}`);

const [codeCfg] = await put('/api/config', { ...cfg0, connections: connexions, devices: [...base, ...equipements] });
await pause(3500);
ok(codeCfg === 200, 'Configuration acceptée avec un canal HTTP et un canal simulé');

const [, cx] = await j('/api/connections');
const piscine = cx.connections.find((c) => c.id === 'piscine');
const sim = cx.connections.find((c) => c.id === 'sim');
ok(piscine?.state === 'connected', `Canal HTTP connecté (${piscine?.devices} équipements)`);
ok(sim?.state === 'connected' && sim.devices === base.length,
   `Le simulateur sert les ${sim?.devices} autres équipements, en parallèle`);

// --- LECTURE : un format pénible, aucun code spécifique ---
const [, st] = await j('/api/state');
const lu = (id) => st.states.find((s) => s.id === id);

ok(lu('test.sensor.ph')?.caps[0]?.value === 7.42, `pH lu tel quel : ${lu('test.sensor.ph')?.caps[0]?.value}`);
ok(lu('test.sensor.temp')?.caps[0]?.value === 26.5,
   `Dixièmes de degré → °C par mise à l'échelle : ${lu('test.sensor.temp')?.caps[0]?.value}`);
ok(lu('test.light.pompe')?.caps[0]?.state === false,
   `Clé imbriquée avec tiret (pompe['en-marche']) → pompe à l'arrêt`);
ok(lu('test.sensor.ph')?.health === 'online', 'Les équipements HTTP sont marqués joignables');

// --- REGROUPEMENT : une requête doit servir les quatre équipements ---
const avant = journal.requetes;
await pause(5000);
const cycles = journal.requetes - avant;
ok(cycles > 0 && cycles <= 4,
   `${cycles} requête(s) en 5 s pour 4 équipements : les lectures d'un même point d'entrée sont groupées`);
ok(journal.entetes.every((e) => e === 'secret-42'), "L'en-tête d'authentification est transmis à chaque appel");

// --- ÉCRITURE : la commande atteint vraiment le matériel ---
journal.ecritures.length = 0;
await post('/api/devices/test.light.pompe/command', { kind: 'switch', state: true });
await pause(600);
ok(journal.ecritures[0] === '{"on":true}',
   `Le régulateur reçoit sa charge utile exacte : ${journal.ecritures[0]}`);

// --- BOUCLE COMPLÈTE : l'écriture change l'état, la lecture le confirme ---
await pause(3500);
const [, st2] = await j('/api/state');
ok(st2.states.find((s) => s.id === 'test.light.pompe')?.caps[0]?.state === true,
   "L'état revient du matériel après écriture — la boucle est fermée");

// --- PANNE : un canal HTTP qui tombe n'emporte pas le reste ---
panne = true;
await pause(4000);
const [, cx2] = await j('/api/connections');
const piscine2 = cx2.connections.find((c) => c.id === 'piscine');
ok(piscine2?.state === 'error', `Panne HTTP signalée : « ${piscine2?.detail} »`);
ok(cx2.connections.find((c) => c.id === 'sim')?.state === 'connected',
   'Le simulateur continue de servir la maison');

const [codeCmd] = await post('/api/devices/z01.light.plafond/command', { kind: 'switch', state: true });
ok(codeCmd === 200, 'Les pièces simulées répondent malgré la panne HTTP');

// --- RÉTABLISSEMENT : le canal doit revenir tout seul ---
panne = false;
await pause(4500);
const [, cx3] = await j('/api/connections');
ok(cx3.connections.find((c) => c.id === 'piscine')?.state === 'connected',
   'Le canal HTTP se rétablit seul, sans redémarrage');

// --- ADRESSE MORTE : le message doit être lisible par un humain ---
const [, mort] = await post('/api/connections/test', {
  id: 'x', kind: 'http', label: 'Mort', enabled: true,
  settings: { baseUrl: 'http://localhost:18999', headers: {}, pollSeconds: 30 },
});
ok(!mort.ok, `Adresse morte refusée à l'essai : « ${mort.error} »`);

// ------------------------------------------------------------------ ménage

await put('/api/config', { ...cfg0, connections: [connexions[0]], devices: base });
await pause(500);
materiel.close();
process.exit(process.exitCode ?? 0);
