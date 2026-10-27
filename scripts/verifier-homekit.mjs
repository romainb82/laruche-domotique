/**
 * Le pont HomeKit, mis a l'epreuve pour de vrai.
 *
 * On ne peut pas s'associer au pont depuis un script : l'association HomeKit
 * demande SRP, ed25519 et ChaCha20, soit un client complet. En revanche on peut
 * verifier tout le reste, et notamment les deux choses qui comptent :
 *
 *   · qu'un VRAI serveur HAP ecoute : il repond 470 a qui n'est pas associe,
 *     ce qu'aucun autre serveur ne fait ;
 *   · que le pont expose les bons equipements, et DIT ce qu'il a laisse dehors
 *     plutot que de le taire.
 *
 * Le pont est allume puis eteint par ce script. Entre les deux, il s'annonce
 * sur le reseau local : c'est precisement ce qu'on teste.
 */
import { connect } from 'node:net';

import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
await ouvrirSession();

const B = 'http://localhost:3001';
const PORT_PONT = 51830; // pas le port par defaut : on ne marche pas sur un vrai pont

const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const put = (u, b) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Interroge le port HAP comme le ferait un iPhone jamais associe.
 *
 * Un serveur HAP repond « 470 Connection Authorization Required ». Un serveur
 * HTTP ordinaire repondrait 200, 404 ou rien : c'est donc une preuve, pas un
 * indice.
 */
function demanderAccessoires(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let recu = '';
    const finir = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(4000, () => finir(null));
    socket.on('error', () => finir(null));
    socket.on('connect', () => socket.write('GET /accessories HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    socket.on('data', (d) => {
      recu += d.toString('latin1');
      if (recu.includes('\r\n')) finir(recu.split('\r\n')[0]);
    });
    socket.on('close', () => resolve(recu.split('\r\n')[0] || null));
  });
}

// ------------------------------------------------------------- configuration

const [, cfg0] = await j('/api/config');
const homekitInitial = cfg0.homekit;

/** On repart d'une maison saine, comme les autres verificateurs. */
const base = cfg0.devices
  .filter((d) => !d.id.startsWith('test.'))
  .map((d) => ({ ...d, binding: null }));
const cfgPropre = {
  ...cfg0,
  connections: [{ id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} }],
  devices: base,
};

const AVEC_SERVICE = ['temperature', 'humidity', 'lux', 'contact'];

/** Ce que le pont DEVRAIT exposer, calcule depuis la maison elle-meme. */
const exposables = base.filter((d) =>
  d.type === 'light' || d.type === 'dimmer' || d.type === 'cover' || d.type === 'thermostat' ||
  (d.type === 'sensor' && AVEC_SERVICE.includes(d.metric)));
const inexposables = base.filter((d) => d.type === 'sensor' && !AVEC_SERVICE.includes(d.metric));

// --------------------------------------------- le code d'association compte

const [codeMauvais, mauvais] = await put('/api/config', {
  ...cfgPropre, homekit: { enabled: true, name: 'Test', pin: '1234', port: PORT_PONT },
});
ok(codeMauvais === 400 && /031-45-154/.test(JSON.stringify(mauvais?.issues ?? '')),
   `Code d'association mal formé refusé : « ${mauvais?.issues?.[0]?.message ?? '-'} »`);

const [codeSuite] = await put('/api/config', {
  ...cfgPropre, homekit: { enabled: true, name: 'Test', pin: '111-11-111', port: PORT_PONT },
});
ok(codeSuite === 400, 'Code d’association trop régulier refusé : il serait devinable');

const [codeUsine, usine] = await put('/api/config', {
  ...cfgPropre, homekit: { enabled: true, name: 'Test', pin: '031-45-154', port: PORT_PONT },
});
ok(codeUsine === 200 && (usine?.warnings ?? []).some((w) => /usine/.test(w.message)),
   'Code d’usine accepté mais signalé : imprudent, pas cassé');

// ----------------------------------------------------------- ouverture du pont

const [codeOuvert] = await put('/api/config', {
  ...cfgPropre,
  homekit: { enabled: true, name: 'Maison de test', pin: '472-19-836', port: PORT_PONT },
});
ok(codeOuvert === 200, 'Configuration acceptée avec le pont ouvert');

/**
 * On attend que le pont publie, au lieu de parier sur une pause fixe.
 *
 * Trois secondes suffisaient d'habitude et ont manque une fois, en suite
 * complete, sur une machine chargee. Une attente elastique dit la meme chose
 * sans dependre de la charge, et en cas d'echec on imprime ce que le serveur
 * pensait, parce qu'un « pont non publie » sans contexte n'est pas
 * diagnosticable apres coup.
 */
let pont = null;
for (let i = 0; i < 30; i++) {
  await pause(500);
  [, pont] = await j('/api/homekit');
  if (pont?.published || pont?.error) break;
}
if (!pont?.published) {
  const [, vu] = await j('/api/config');
  console.log(`       (le serveur voyait homekit = ${JSON.stringify(vu?.homekit)})`);
}
ok(pont?.published === true, `Pont publié ${pont?.error ? `,  ${pont.error}` : ''}`);
ok(pont?.exposes === exposables.length,
   `${pont?.exposes} accessoires exposés, pour ${exposables.length} équipements exposables`);
ok(pont?.skipped?.length === inexposables.length,
   `${pont?.skipped?.length} équipement(s) écarté(s) sur ${inexposables.length} sans équivalent HomeKit`);
const ecartes = pont?.skipped ?? [];
ok(ecartes.length > 0 && ecartes.every((s) => s.raison && s.raison.length > 10),
   `Chaque équipement écarté porte une raison lisible : « ${ecartes[0]?.raison ?? '-'} »`);

// --- LA PREUVE : un vrai serveur HAP, pas un serveur HTTP quelconque ---
const ligne = await demanderAccessoires(PORT_PONT);
ok(/470/.test(ligne ?? ''),
   `Le port répond en HAP à un appareil non associé : « ${ligne ?? 'aucune réponse'} »`);

// --- Le code n'est montre que pont ouvert ---
ok(pont?.pin === '472-19-836', 'Le code d’association est lisible tant que le pont est ouvert');

// --------------------------------------------------------- fermeture du pont

const [codeFerme] = await put('/api/config', {
  ...cfgPropre,
  homekit: { enabled: false, name: 'Maison de test', pin: '472-19-836', port: PORT_PONT },
});
ok(codeFerme === 200, 'Pont refermé');

let ferme = null;
for (let i = 0; i < 20; i++) {
  await pause(500);
  [, ferme] = await j('/api/homekit');
  if (!ferme?.published) break;
}
ok(ferme?.published === false, 'Le pont ne publie plus');
ok(ferme?.pin === null, 'Le code d’association disparaît dès que le pont est fermé');

const apres = await demanderAccessoires(PORT_PONT);
ok(apres === null, `Le port HAP ne répond plus : ${apres ?? 'silence'}`);

// ------------------------------------------------------------------- menage

await put('/api/config', { ...cfgPropre, homekit: homekitInitial });
await pause(500);
process.exit(process.exitCode ?? 0);
