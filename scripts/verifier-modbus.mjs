/**
 * Le canal Modbus, mis a l'epreuve contre un VRAI esclave.
 *
 * On monte un faux equipement technique qui parle le protocole pour de bon : * en-tete MBAP, codes fonction, exceptions, et on verifie que le meme moteur
 * de transformation le comprend sans une ligne de code specifique.
 *
 * Ce qui est verifie ici et nulle part ailleurs :
 *   · un entier signe au dixieme redevient une temperature negative ;
 *   · un flottant sur deux registres se lit dans les deux ordres de mots ;
 *   · une ecriture atteint reellement le bon registre, avec la bonne valeur ;
 *   · les registres voisins sont groupes plutot que demandes un par un ;
 *   · une table en lecture seule refuse l'ecriture, avec un message lisible ;
 *   · le balayage tient lieu de decouverte, puisque le protocole n'en a pas.
 */
import { createServer } from 'node:net';

import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
await ouvrirSession();

const B = 'http://localhost:3001';
const PORT = 18850;

const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const put = (u, b) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const post = (u, b) => j(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- le faux equipement

/**
 * La memoire de l'esclave.
 *
 * Volontairement penible, comme le vrai materiel : la temperature est un entier
 * signe au dixieme, la consigne est ailleurs, la puissance est un flottant a
 * cheval sur deux registres, et le bit de demande traine dans une autre table.
 */
const holding = new Uint16Array(400);
const input = new Uint16Array(400);
const coils = new Uint8Array(64);
const discrete = new Uint8Array(64);

const ecrireInt16 = (tab, adr, v) => { tab[adr] = v < 0 ? v + 0x10000 : v; };
const ecrireFloat = (tab, adr, v, swap = false) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  const haut = b.readUInt16BE(0), bas = b.readUInt16BE(2);
  tab[adr] = swap ? bas : haut;
  tab[adr + 1] = swap ? haut : bas;
};

ecrireInt16(holding, 100, -35);        // exterieure : -3,5 °C, le cas qui casse tout
ecrireInt16(holding, 200, 205);        // consigne : 20,5 °C
ecrireInt16(holding, 201, 193);        // ambiante : 19,3 °C
ecrireFloat(input, 300, 1234.5);       // puissance, mot de poids fort en premier
ecrireFloat(input, 310, 987.25, true); // la meme chose, mots inverses
coils[0] = 1;
discrete[10] = 1;                      // la machine demande de la chaleur

const journal = { requetes: 0, ecritures: [] };
let muet = false;

const esclave = createServer((socket) => {
  let tampon = Buffer.alloc(0);

  socket.on('data', (bloc) => {
    tampon = Buffer.concat([tampon, bloc]);

    while (tampon.length >= 8) {
      const longueur = tampon.readUInt16BE(4);
      const total = 6 + longueur;
      if (tampon.length < total) return;

      const trame = tampon.subarray(0, total);
      tampon = tampon.subarray(total);
      if (muet) continue;

      const transaction = trame.readUInt16BE(0);
      const unite = trame.readUInt8(6);
      const fc = trame.readUInt8(7);
      const adr = trame.readUInt16BE(8);
      journal.requetes++;

      const repondre = (corps) => {
        const out = Buffer.alloc(7 + corps.length);
        out.writeUInt16BE(transaction, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(1 + corps.length, 4);
        out.writeUInt8(unite, 6);
        corps.copy(out, 7);
        socket.write(out);
      };
      const refuser = (code) => repondre(Buffer.from([fc | 0x80, code]));

      // --- lectures de bits (FC 1 et 2) ---
      if (fc === 1 || fc === 2) {
        const n = trame.readUInt16BE(10);
        const source = fc === 1 ? coils : discrete;
        if (adr + n > source.length) { refuser(2); continue; }
        const octets = Math.ceil(n / 8);
        const corps = Buffer.alloc(2 + octets);
        corps.writeUInt8(fc, 0);
        corps.writeUInt8(octets, 1);
        for (let i = 0; i < n; i++) if (source[adr + i]) corps[2 + (i >> 3)] |= 1 << (i % 8);
        repondre(corps);
        continue;
      }

      // --- lectures de mots (FC 3 et 4) ---
      if (fc === 3 || fc === 4) {
        const n = trame.readUInt16BE(10);
        const source = fc === 3 ? holding : input;
        // Un vrai esclave refuse ce qu'il n'a pas : c'est l'exception 2, la
        // plus frequente, et celle dont le message doit etre limpide.
        if (adr + n > source.length) { refuser(2); continue; }
        const corps = Buffer.alloc(2 + n * 2);
        corps.writeUInt8(fc, 0);
        corps.writeUInt8(n * 2, 1);
        for (let i = 0; i < n; i++) corps.writeUInt16BE(source[adr + i], 2 + i * 2);
        repondre(corps);
        continue;
      }

      // --- ecriture d'une bobine (FC 5) ---
      if (fc === 5) {
        const v = trame.readUInt16BE(10) === 0xff00;
        coils[adr] = v ? 1 : 0;
        journal.ecritures.push({ fc, adr, valeur: v });
        repondre(trame.subarray(7, 12));
        continue;
      }

      // --- ecriture d'un registre (FC 6) ---
      if (fc === 6) {
        const v = trame.readUInt16BE(10);
        holding[adr] = v;
        journal.ecritures.push({ fc, adr, valeur: v });
        repondre(trame.subarray(7, 12));
        continue;
      }

      refuser(1);
    }
  });
  socket.on('error', () => {});
});

await new Promise((r) => esclave.listen(PORT, r));
console.log(`esclave Modbus de test sur ${PORT}\n`);

// ------------------------------------------------------------- configuration

const [, cfg0] = await j('/api/config');

/** On repart d'une maison saine : les executions precedentes laissent des raccordements. */
const base = cfg0.devices
  .filter((d) => !d.id.startsWith('test.'))
  .map((d) => ({ ...d, binding: null }));

const canal = {
  id: 'pac', kind: 'modbus', label: 'Pompe à chaleur', enabled: true,
  settings: {
    host: '127.0.0.1', port: PORT, unitId: 1, pollSeconds: 2,
    scanTable: 'holding', scanFrom: 0, scanCount: 0,
  },
};
const connexions = [
  { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
  canal,
];

const equipements = [
  {
    // Entier signe au dixieme, valeur NEGATIVE.
    id: 'test.sensor.exterieure', zoneId: 'z21', label: 'Température extérieure',
    type: 'sensor', metric: 'temperature', order: 90, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [{ source: 'holding:100:int16', path: '', into: 'sensor.value',
                pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] }],
      writes: [] },
  },
  {
    // Flottant sur deux registres, mot de poids fort en premier.
    id: 'test.sensor.puissance', zoneId: 'z00', label: 'Puissance absorbée',
    type: 'sensor', metric: 'power', order: 91, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [{ source: 'input:300:float32', path: '', into: 'sensor.value',
                pipeline: [{ op: 'round', decimals: 1 }] }],
      writes: [] },
  },
  {
    // Le MEME nombre, mots inverses : sans le reglage, on lirait n'importe quoi.
    id: 'test.sensor.puissance2', zoneId: 'z00', label: 'Puissance, mots inversés',
    type: 'sensor', metric: 'power', order: 92, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [{ source: 'input:310:float32-swap', path: '', into: 'sensor.value',
                pipeline: [{ op: 'round', decimals: 2 }] }],
      writes: [] },
  },
  {
    // Trois lectures dans deux tables, plus une ecriture.
    id: 'test.thermostat.pac', zoneId: 'z00', label: 'Consigne PAC',
    type: 'thermostat', order: 93, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [
        { source: 'holding:200:int16', path: '', into: 'climate.setpoint', pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] },
        { source: 'holding:201:int16', path: '', into: 'climate.ambient', pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] },
        { source: 'discrete:10', path: '', into: 'climate.demand', pipeline: [] },
      ],
      writes: [{ on: 'climate', target: 'holding:200', payload: '{{valeur}}',
                 pipeline: [{ op: 'scale', factor: 10, offset: 0 }, { op: 'round', decimals: 0 }], method: 'POST' }] },
  },
  {
    id: 'test.light.relais', zoneId: 'z00', label: 'Relais appoint', type: 'light',
    order: 94, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [{ source: 'coil:0', path: '', into: 'switch.state', pipeline: [] }],
      writes: [{ on: 'switch', target: 'coil:0', payload: '{{valeur}}', pipeline: [], method: 'POST' }] },
  },
  {
    // Cible en LECTURE SEULE : l'erreur doit etre dite avant d'atteindre le reseau.
    id: 'test.light.interdit', zoneId: 'z00', label: 'Écriture interdite', type: 'light',
    order: 95, staleAfterSeconds: 300, sim: {},
    binding: { connectionId: 'pac',
      reads: [{ source: 'discrete:10', path: '', into: 'switch.state', pipeline: [] }],
      writes: [{ on: 'switch', target: 'discrete:10', payload: '{{valeur}}', pipeline: [], method: 'POST' }] },
  },
];

// -------------------------------------------------------------------- essais

const [codeTest, essai] = await post('/api/connections/test', canal);
ok(codeTest === 200 && essai?.ok,
   `Essai à blanc du canal Modbus : ${essai?.ok ? `répond en ${essai.ms} ms` : essai?.error}`);

const [codeCfg] = await put('/api/config', { ...cfg0, connections: connexions, devices: [...base, ...equipements] });
await pause(3000);
ok(codeCfg === 200, 'Configuration acceptée avec un canal Modbus et un canal simulé');

const [, cx] = await j('/api/connections');
const pac = cx.connections.find((c) => c.id === 'pac');
const sim = cx.connections.find((c) => c.id === 'sim');
ok(pac?.state === 'connected', `Canal Modbus connecté (${pac?.devices} équipements) ${pac?.detail ?? ''}`);
ok(sim?.state === 'connected' && sim.devices === base.length,
   `Le simulateur sert les ${sim?.devices} autres équipements, en parallèle`);

// --- LECTURE : des formats penibles, aucun code specifique ---
const [, st] = await j('/api/state');
const lu = (id) => st.states.find((s) => s.id === id);
const cap = (id, kind) => lu(id)?.caps.find((c) => c.kind === kind);

ok(cap('test.sensor.exterieure', 'sensor')?.value === -3.5,
   `Entier signé négatif au dixième → °C : ${cap('test.sensor.exterieure', 'sensor')?.value}`);
ok(cap('test.sensor.puissance', 'sensor')?.value === 1234.5,
   `Flottant 32 bits sur deux registres : ${cap('test.sensor.puissance', 'sensor')?.value}`);
ok(cap('test.sensor.puissance2', 'sensor')?.value === 987.25,
   `Le même nombre, mots inversés, relu correctement : ${cap('test.sensor.puissance2', 'sensor')?.value}`);

const climat = cap('test.thermostat.pac', 'climate');
ok(climat?.setpoint === 20.5 && climat?.ambient === 19.3,
   `Consigne et ambiante lues dans deux registres : ${climat?.setpoint} / ${climat?.ambient}`);
ok(climat?.demand === true, 'Le bit de demande de chauffe vient d’une AUTRE table (discrete)');
ok(cap('test.light.relais', 'switch')?.state === true, 'Une bobine se lit comme un interrupteur');

// --- REGROUPEMENT : holding:200 et 201 doivent tenir en UNE requete ---
const avant = journal.requetes;
await pause(4500);
const cycles = journal.requetes - avant;
ok(cycles > 0 && cycles <= 12,
   `${cycles} requête(s) en 4,5 s pour 6 équipements : les registres voisins sont groupés`);

// --- ECRITURE : la commande atteint le bon registre, avec la bonne valeur ---
journal.ecritures.length = 0;
await post('/api/devices/test.thermostat.pac/command', { kind: 'climate', setpoint: 21.5 });
await pause(800);
const ecrit = journal.ecritures.find((e) => e.fc === 6);
ok(ecrit?.adr === 200 && ecrit?.valeur === 215,
   `Consigne écrite au registre ${ecrit?.adr}, valeur ${ecrit?.valeur} (21,5 °C au dixième)`);

await post('/api/devices/test.light.relais/command', { kind: 'switch', state: false });
await pause(800);
const bobine = journal.ecritures.find((e) => e.fc === 5);
ok(bobine?.adr === 0 && bobine?.valeur === false,
   `Bobine ${bobine?.adr} mise à « ${bobine?.valeur} » par le code fonction 5`);

// --- BOUCLE COMPLETE : l'ecriture change l'etat, la lecture le confirme ---
await pause(3000);
const [, st2] = await j('/api/state');
const relu = st2.states.find((s) => s.id === 'test.thermostat.pac')?.caps.find((c) => c.kind === 'climate');
ok(relu?.setpoint === 21.5, "La consigne revient du matériel après écriture : la boucle est fermée");

// --- LECTURE SEULE : refusee avant d'atteindre le reseau ---
const [, refus] = await post('/api/devices/test.light.interdit/command', { kind: 'switch', state: true });
ok(refus?.ok === false && /lecture seule/i.test(refus?.error ?? ''),
   `Écriture sur une table en lecture seule refusée : « ${refus?.error} »`);

// --- PORT MORT : le message doit etre lisible par un humain ---
const [, adresseMorte] = await post('/api/connections/test', {
  ...canal, id: 'x', settings: { ...canal.settings, port: 18999 },
});
ok(!adresseMorte?.ok && /refus|injoignable|répond pas/i.test(adresseMorte?.error ?? ''),
   `Port mort refusé à l'essai : « ${adresseMorte?.error} »`);

// --- BALAYAGE : ce qui tient lieu de decouverte ---
await put('/api/config', {
  ...cfg0,
  connections: [connexions[0], { ...canal, settings: { ...canal.settings, scanFrom: 100, scanCount: 4 } }],
  devices: [...base, ...equipements],
});
await pause(3500);
const [, decouverte] = await j('/api/discovery');
const trouve = decouverte.candidates.filter((c) => c.connectionId === 'pac');
const cent = trouve.find((c) => c.source.startsWith('holding:100'));
ok(trouve.length >= 4, `Balayage : ${trouve.length} registre(s) remontés, faute de découverte possible`);
ok(cent?.paths.some((p) => p.path === 'int16' && p.sample === '-35'),
   `Le registre 100 est montré dans ses lectures possibles, dont int16 = ${cent?.paths.find((p) => p.path === 'int16')?.sample}`);

// --- PANNE : un esclave muet n'emporte pas le reste de la maison ---
muet = true;
await pause(7000);
const [, cx2] = await j('/api/connections');
ok(cx2.connections.find((c) => c.id === 'pac')?.state === 'error',
   `Silence de l'esclave signalé : « ${cx2.connections.find((c) => c.id === 'pac')?.detail} »`);
ok(cx2.connections.find((c) => c.id === 'sim')?.state === 'connected',
   'Le simulateur continue de servir la maison');

muet = false;

// -------------------------------------------------------------------- menage

await put('/api/config', { ...cfg0, connections: [connexions[0]], devices: base });
await pause(500);
await fetch(`${B}/api/discovery?connection=pac`, { method: 'DELETE' }).catch(() => {});
esclave.close();
process.exit(process.exitCode ?? 0);
