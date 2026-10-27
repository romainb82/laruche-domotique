/**
 * Le cerveau, mis a l'epreuve contre un VRAI broker MQTT.
 *
 * On simule trois materiels aux formats volontairement differents : Shelly
 * (JSON imbrique, cle 'switch:0'), Zigbee2MQTT (texte 'ON'/'OFF', volet inverse)
 * et un capteur brut (texte nu), et on verifie que le meme moteur les comprend
 * tous les trois sans une ligne de code specifique.
 */
import Aedes from 'aedes';
import { createServer } from 'node:net';
import mqtt from 'mqtt';

import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
await ouvrirSession();

const PORT = 18830;
const B = 'http://localhost:3001';
const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const send = (m) => (u, b) => j(u, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const post = send('POST'), put = send('PUT');
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. un broker, en memoire ---
const aedes = new Aedes();
const serveur = createServer(aedes.handle);
await new Promise((r) => serveur.listen(PORT, r));
console.log(`broker de test sur ${PORT}\n`);

const materiel = mqtt.connect(`mqtt://localhost:${PORT}`);
await new Promise((r) => materiel.on('connect', r));

// ce que le "materiel" recoit comme ordres
const recus = [];
await materiel.subscribeAsync(['maison/+/rpc', 'maison/+/set']);
materiel.on('message', (t, p) => recus.push({ topic: t, payload: p.toString() }));

// --- 2. on declare la connexion et trois equipements ---
const [, cfg0] = await j('/api/config');
const base = cfg0.devices.filter((d) => !d.id.startsWith('test.'));

/**
 * Les connexions de la maison sont CONSERVEES, et les deux canaux de test
 * s'y ajoutent.
 *
 * Deux raisons, decouvertes en branchant un vrai Home Assistant :
 *
 *   . les equipements de `base` gardent leurs raccordements, et un equipement
 *     qui pointe vers une connexion absente de la liste fait refuser toute la
 *     configuration, a juste titre ;
 *   . le menage de fin ne restaurait qu'une seule connexion, donc lancer la
 *     verification SUPPRIMAIT les canaux reels de la maison.
 */
const connexionsMaison = (cfg0.connections ?? []).filter(
  (c) => c.id !== 'sim' && c.id !== 'brk',
);

const connexions = [
  { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
  { id: 'brk', kind: 'mqtt', label: 'Broker de test', enabled: true,
    settings: { url: `mqtt://localhost:${PORT}`, username: '', password: '', baseTopic: 'maison' } },
  ...connexionsMaison,
];

const equipements = [
  { // Shelly : JSON imbrique, cle avec deux-points
    id: 'test.light.shelly', zoneId: 'z01', label: 'Lampe Shelly', type: 'light',
    order: 90, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'brk',
      reads: [{ source: 'shelly1/status/switch:0', path: 'output', into: 'switch.state', pipeline: [{ op: 'bool', truthy: [] }] }],
      writes: [{ on: 'switch', target: 'shelly1/rpc', payload: '{"method":"Switch.Set","params":{"on":{{valeur}}}}', pipeline: [], method: 'POST' }] } },
  { // Zigbee2MQTT : texte ON/OFF, volet qui compte la FERMETURE
    id: 'test.cover.z2m', zoneId: 'z01', label: 'Volet Zigbee', type: 'cover',
    order: 91, staleAfterSeconds: 300, sim: { travelSeconds: 5 },
    binding: { connectionId: 'brk',
      reads: [{ source: 'volet1', path: 'position', into: 'cover.position', pipeline: [{ op: 'number' }, { op: 'invert', span: 100 }] }],
      writes: [{ on: 'cover', target: 'volet1/set', payload: '{"position":{{valeur}}}', pipeline: [{ op: 'invert', span: 100 }, { op: 'round', decimals: 0 }], method: 'POST' }] } },
  { // capteur brut : texte nu, en dixiemes de degre
    id: 'test.sensor.brut', zoneId: 'z01', label: 'Sonde brute', type: 'sensor', metric: 'temperature',
    order: 92, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'brk',
      reads: [{ source: 'sonde1/temp', path: '', into: 'sensor.value', pipeline: [{ op: 'number' }, { op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] }],
      writes: [] } },
];

const [codeCfg] = await put('/api/config', { ...cfg0, connections: connexions, devices: [...base, ...equipements] });
await pause(1500);
ok(codeCfg === 200, 'Configuration acceptee avec deux canaux simultanes');

const [, st0] = await j('/api/connections');
const brk = st0.connections.find((c) => c.id === 'brk');
const sim = st0.connections.find((c) => c.id === 'sim');
ok(brk?.state === 'connected', `Canal MQTT connecte (${brk?.devices} equipements)`);
// Le compte attendu se CALCULE : les equipements deja raccordes a un vrai
// canal (Home Assistant, par exemple) ne tombent pas au simulateur. L'ecrire
// en dur faisait echouer le test des qu'on branchait un equipement reel.
const canaux = new Set(connexions.filter((c) => c.enabled && c.id !== 'sim').map((c) => c.id));
const attendus = base.filter((d) => !d.binding || !canaux.has(d.binding.connectionId)).length;
ok(sim?.state === 'connected' && sim.devices === attendus,
   `Simulateur sert les ${sim?.devices} equipements non raccordes (${attendus} attendus), en parallele`);

// --- 3. LECTURE : trois formats, un seul moteur ---
await materiel.publishAsync('maison/shelly1/status/switch:0', JSON.stringify({ output: true, apower: 12.4 }));
await materiel.publishAsync('maison/volet1', JSON.stringify({ position: 30, linkquality: 88 }));
await materiel.publishAsync('maison/sonde1/temp', '213');
await pause(1200);

const [, st] = await j('/api/state');
const lu = (id) => st.states.find((s) => s.id === id);

const lampe = lu('test.light.shelly');
ok(lampe?.caps[0]?.state === true && lampe.health === 'online',
   `Shelly : JSON imbrique + cle 'switch:0' -> allumee`);

const volet = lu('test.cover.z2m');
ok(volet?.caps[0]?.position === 70,
   `Zigbee : position 30 (fermeture) -> 70 % ouvert apres inversion`);

const sonde = lu('test.sensor.brut');
ok(sonde?.caps[0]?.value === 21.3,
   `Capteur brut : texte "213" -> 21.3 °C apres mise a l'echelle`);

// --- 4. ECRITURE : la commande ressort au format du materiel ---
recus.length = 0;
await post('/api/devices/test.light.shelly/command', { kind: 'switch', state: true });
await post('/api/devices/test.cover.z2m/command', { kind: 'cover', position: 80 });
await pause(900);

const ordreShelly = recus.find((r) => r.topic === 'maison/shelly1/rpc');
ok(ordreShelly?.payload === '{"method":"Switch.Set","params":{"on":true}}',
   `Shelly recoit son RPC exact : ${ordreShelly?.payload}`);

const ordreVolet = recus.find((r) => r.topic === 'maison/volet1/set');
ok(ordreVolet?.payload === '{"position":20}',
   `Zigbee : demande 80 % ouvert -> ${ordreVolet?.payload} (reinverse)`);

// --- 5. DECOUVERTE : ce qui parle sans etre reclame ---
await materiel.publishAsync('maison/inconnu42/state', JSON.stringify({ temperature: 19.4, battery: 87 }));
await pause(900);
const [, dec] = await j('/api/discovery');
const trouve = dec.candidates.find((c) => c.source === 'inconnu42/state');
ok(!!trouve, `Decouverte : equipement inconnu repere sur le reseau`);
ok(trouve?.paths.some((p) => p.path === 'temperature' && p.sample === '19.4'),
   `Decouverte : champs proposes automatiquement (${trouve?.paths.map((p) => p.path).join(', ')})`);

// --- 6. RESILIENCE : un canal qui tombe n'emporte pas les autres ---
// On coupe brutalement, comme une vraie panne : le client de test part en
// premier, puis on force la fermeture des sockets restantes du serveur.
materiel.end(true);
serveur.closeAllConnections?.();
serveur.close();
await new Promise((r) => aedes.close(r));
await pause(7000);
const [, st2] = await j('/api/connections');
const brk2 = st2.connections.find((c) => c.id === 'brk');
const sim2 = st2.connections.find((c) => c.id === 'sim');
ok(sim2?.state === 'connected', 'Broker tombe : le simulateur continue de servir la maison');
ok(brk2?.state !== 'connected', `Broker tombe : le canal le signale (${brk2?.state})`);

const [codeCmd] = await post('/api/devices/z01.light.plafond/command', { kind: 'switch', state: true });
ok(codeCmd === 200, 'Broker tombe : les pieces simulees repondent toujours');

// --- menage ---
// On remet EXACTEMENT ce qu'on a trouve en arrivant : les canaux de la maison
// n'ont pas a disparaitre parce qu'on a lance une verification.
await put('/api/config', { ...cfg0, connections: cfg0.connections, devices: base });
await pause(500);
process.exit(process.exitCode ?? 0);
