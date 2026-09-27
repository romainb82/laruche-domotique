/**
 * Le planificateur de scenes, mis a l'epreuve.
 *
 * Deux moities tres differentes.
 *
 * La premiere est du calcul pur : a quelle heure part une scene. C'est le seul
 * endroit du projet ou une erreur ne se voit pas — un volet qui s'ouvre a 6 h
 * au lieu de 7 h pendant six mois ne leve aucune alerte. On verifie donc le
 * passage a l'heure d'ete, ou deux departs consecutifs de « 07:00 » sont
 * separes par 23 heures et non 24.
 *
 * La seconde attend vraiment que l'heure tourne : une scene est programmee au
 * prochain changement de minute, et on regarde si elle part. C'est long, et
 * c'est le seul moyen de savoir.
 */
import { prochaineOccurrence, decalageMinutes, decrireTrigger } from '../packages/shared/dist/index.js';

const B = 'http://localhost:3001';
const TZ = 'Europe/Paris';

const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const put = (u, b) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const post = (u, b) => j(u, b === undefined
  ? { method: 'POST' }
  : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ calcul pur

const TOUS = [0, 1, 2, 3, 4, 5, 6];

// --- le fuseau est bien celui de la maison, pas celui de la machine ---
ok(decalageMinutes(new Date('2026-01-15T12:00:00Z'), TZ) === 60,
   `Paris en janvier : UTC+${decalageMinutes(new Date('2026-01-15T12:00:00Z'), TZ) / 60}`);
ok(decalageMinutes(new Date('2026-07-15T12:00:00Z'), TZ) === 120,
   `Paris en juillet : UTC+${decalageMinutes(new Date('2026-07-15T12:00:00Z'), TZ) / 60}`);

// --- passage a l'heure d'ete : le 29 mars 2026, 07:00 arrive une heure plus tot en UTC ---
const veille = prochaineOccurrence({ kind: 'time', at: '07:00', days: TOUS },
                                   new Date('2026-03-27T23:30:00Z'), TZ);
const lendemain = prochaineOccurrence({ kind: 'time', at: '07:00', days: TOUS },
                                      new Date('2026-03-28T12:00:00Z'), TZ);
ok(veille?.toISOString() === '2026-03-28T06:00:00.000Z',
   `07:00 du 28 mars (heure d'hiver) = ${veille?.toISOString()}`);
ok(lendemain?.toISOString() === '2026-03-29T05:00:00.000Z',
   `07:00 du 29 mars (heure d'été) = ${lendemain?.toISOString()}`);
const ecart = (lendemain - veille) / 3_600_000;
ok(ecart === 23,
   `Deux « 07:00 » consécutifs séparés par ${ecart} h au changement d'heure, pas 24`);

// --- retour a l'heure d'hiver : 25 octobre 2026, l'ecart est de 25 h ---
const avant = prochaineOccurrence({ kind: 'time', at: '07:00', days: TOUS },
                                  new Date('2026-10-23T23:30:00Z'), TZ);
const apres = prochaineOccurrence({ kind: 'time', at: '07:00', days: TOUS },
                                  new Date('2026-10-24T12:00:00Z'), TZ);
ok((apres - avant) / 3_600_000 === 25,
   `Et ${(apres - avant) / 3_600_000} h au retour à l'heure d'hiver`);

// --- les jours cochés sont respectés, et la semaine se boucle ---
// Le 2026-09-26 est un samedi. Une scène « en semaine » doit sauter au lundi.
const enSemaine = prochaineOccurrence({ kind: 'time', at: '07:00', days: [1, 2, 3, 4, 5] },
                                      new Date('2026-09-26T10:00:00Z'), TZ);
ok(enSemaine?.toISOString() === '2026-09-28T05:00:00.000Z',
   `Samedi, une scène « en semaine » attend le lundi : ${enSemaine?.toISOString()}`);

// --- une heure déjà passée aujourd'hui repart demain ---
const demain = prochaineOccurrence({ kind: 'time', at: '07:00', days: TOUS },
                                   new Date('2026-09-26T08:00:00Z'), TZ);
ok(demain?.toISOString() === '2026-09-27T05:00:00.000Z',
   `Une heure déjà passée repart le lendemain : ${demain?.toISOString()}`);

// --- ce qui ne part jamais rend null, au lieu d'une date fausse ---
ok(prochaineOccurrence({ kind: 'manual' }, new Date(), TZ) === null,
   'Une scène manuelle n’a pas de prochain départ');
ok(prochaineOccurrence({ kind: 'time', at: '07:00', days: [] }, new Date(), TZ) === null,
   'Aucun jour coché : aucun départ, plutôt qu’un départ surprise');
ok(prochaineOccurrence({ kind: 'time', at: '25:00', days: TOUS }, new Date(), TZ) === null,
   'Une heure impossible ne produit pas de date');

// --- la description est lisible ---
ok(decrireTrigger({ kind: 'time', at: '07:00', days: [1, 2, 3, 4, 5] }) === 'En semaine à 07:00',
   `Déclencheur en français : « ${decrireTrigger({ kind: 'time', at: '07:00', days: [1, 2, 3, 4, 5] })} »`);
ok(decrireTrigger({ kind: 'time', at: '23:30', days: TOUS }) === 'Tous les jours à 23:30',
   `Et pour tous les jours : « ${decrireTrigger({ kind: 'time', at: '23:30', days: TOUS })} »`);

// ============================================================ le serveur

const [, cfg0] = await j('/api/config');
const base = cfg0.devices.filter((d) => !d.id.startsWith('test.')).map((d) => ({ ...d, binding: null }));
const propre = {
  ...cfg0,
  connections: [{ id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} }],
  devices: base,
};

const lampeA = 'z01.light.plafond';   // cuisine
const lampeB = 'z03.light.general';   // salon
const temoin = 'z02.light.plafond';   // buanderie, sert de condition

const etat = async (id) => {
  const [, st] = await j('/api/state');
  return st.states.find((s) => s.id === id)?.caps.find((c) => c.kind === 'switch')?.state;
};

/** L'heure murale de la maison, au prochain changement de minute utile. */
function prochaineMinute(marge = 25) {
  const maintenant = new Date();
  let cible = new Date(Math.ceil(maintenant.getTime() / 60_000) * 60_000);
  if (cible - maintenant < marge * 1000) cible = new Date(cible.getTime() + 60_000);
  const hhmm = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(cible);
  return { hhmm, at: cible };
}

// --- 1. LA CONDITION : une scène gardée ne part pas si la garde est fausse ---
await post(`/api/devices/${temoin}/command`, { kind: 'switch', state: false });
await post(`/api/devices/${lampeA}/command`, { kind: 'switch', state: false });
await pause(700);

const gardee = {
  id: 'test.gardee', label: 'Test gardée', icon: 'ampoule', order: 90,
  enabled: true,
  trigger: { kind: 'manual' },
  condition: { kind: 'device', deviceId: temoin, is: 'on' },
  actions: [{ deviceId: lampeA, command: { kind: 'switch', state: true } }],
};
await put('/api/config', { ...propre, scenes: [...cfg0.scenes, gardee] });
await pause(900);

const [, refus] = await post('/api/scenes/test.gardee/apply');
ok(refus?.ok === false && /Condition non remplie/.test(refus?.refus ?? ''),
   `Condition fausse : la scène ne part pas — « ${refus?.refus} »`);
ok((await etat(lampeA)) === false, 'Et aucune lampe n’a bougé');

// La garde devient vraie : la même scène part.
await post(`/api/devices/${temoin}/command`, { kind: 'switch', state: true });
await pause(800);
const [, passe] = await post('/api/scenes/test.gardee/apply');
await pause(700);
ok(passe?.ok === true && (await etat(lampeA)) === true,
   `Condition vraie : la scène part et la lampe s’allume`);

// --- 2. LES RETARDS : une action différée arrive plus tard, pas tout de suite ---
await post(`/api/devices/${lampeA}/command`, { kind: 'switch', state: false });
await post(`/api/devices/${lampeB}/command`, { kind: 'switch', state: false });
await pause(700);

const sequence = {
  id: 'test.sequence', label: 'Test séquence', icon: 'eclair', order: 91,
  enabled: true, trigger: { kind: 'manual' }, condition: { kind: 'always' },
  actions: [
    { deviceId: lampeA, command: { kind: 'switch', state: true } },
    { deviceId: lampeB, command: { kind: 'switch', state: true }, afterSeconds: 4 },
  ],
};
await put('/api/config', { ...propre, scenes: [...cfg0.scenes, sequence] });
await pause(900);

const [, seq] = await post('/api/scenes/test.sequence/apply');
await pause(800);
ok(seq?.retardees === 1, `${seq?.retardees} action annoncée comme retardée`);
ok((await etat(lampeA)) === true && (await etat(lampeB)) === false,
   'À l’instant du départ : la première a agi, la seconde pas encore');
await pause(4500);
ok((await etat(lampeB)) === true, 'Quatre secondes plus tard, la seconde a agi');

// --- 3. LE REPOS : une scène au repos ne part pas seule, mais se joue à la main ---
const { hhmm, at } = prochaineMinute();
const repos = {
  id: 'test.repos', label: 'Test repos', icon: 'lune', order: 92,
  enabled: false,
  trigger: { kind: 'time', at: hhmm, days: [0, 1, 2, 3, 4, 5, 6] },
  condition: { kind: 'always' },
  actions: [{ deviceId: lampeA, command: { kind: 'switch', state: false } }],
};
await put('/api/config', { ...propre, scenes: [...cfg0.scenes, repos] });
await pause(900);
const [, prochain0] = await j('/api/scenes/next');
ok(prochain0?.next?.sceneId !== 'test.repos',
   'Une scène au repos n’apparaît pas dans les prochains départs');
const [, main] = await post('/api/scenes/test.repos/apply');
ok(main?.ok === true, 'Mais on peut toujours la jouer à la main');

// --- 4. LE DÉPART PROGRAMMÉ : on attend vraiment l'heure ---
await post(`/api/devices/${lampeA}/command`, { kind: 'switch', state: true });
await pause(700);

const { hhmm: heure, at: quand } = prochaineMinute(25);
const programmee = {
  id: 'test.programmee', label: 'Test programmée', icon: 'soleil', order: 93,
  enabled: true,
  trigger: { kind: 'time', at: heure, days: [0, 1, 2, 3, 4, 5, 6] },
  condition: { kind: 'always' },
  actions: [{ deviceId: lampeA, command: { kind: 'switch', state: false } }],
};
await put('/api/config', { ...propre, scenes: [...cfg0.scenes, programmee] });
await pause(900);

const [, prochain] = await j('/api/scenes/next');
ok(prochain?.next?.sceneId === 'test.programmee',
   `Prochain départ annoncé : ${prochain?.next?.label} à ${prochain?.next?.at}`);

const attente = Math.max(0, quand - Date.now()) + 22_000;
console.log(`       (attente de ${Math.round(attente / 1000)} s : le départ est prévu à ${heure})`);
await pause(attente);

ok((await etat(lampeA)) === false,
   `La scène est partie toute seule à ${heure} et a éteint la lampe`);

const [, hist] = await j('/api/scenes/history?limit=20');
const auto = hist?.runs?.find((r) => r.sceneId === 'test.programmee' && r.origin === 'schedule');
ok(!!auto, `Le journal retient le départ automatique : ${auto?.total} action(s), ${auto?.echecs} échec(s)`);
const refuse = hist?.runs?.find((r) => r.sceneId === 'test.gardee' && r.refus);
ok(!!refuse, `Et garde la raison d’un refus : « ${refuse?.refus} »`);

// --- 5. LA VALIDATION refuse ce qui ne partirait jamais ---
const [codeVide] = await put('/api/config', {
  ...propre,
  scenes: [...cfg0.scenes, { ...programmee, id: 'test.vide', trigger: { kind: 'time', at: '07:00', days: [] } }],
});
ok(codeVide === 400, 'Une scène horaire sans aucun jour coché est refusée');

const [codeHeure] = await put('/api/config', {
  ...propre,
  scenes: [...cfg0.scenes, { ...programmee, id: 'test.heure', trigger: { kind: 'time', at: '7h', days: [1] } }],
});
ok(codeHeure === 400, 'Une heure mal écrite est refusée');

// ------------------------------------------------------------------ menage

await put('/api/config', { ...propre, scenes: cfg0.scenes });
await pause(500);
process.exit(process.exitCode ?? 0);
