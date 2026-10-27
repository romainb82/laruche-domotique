/**
 * Le parcours reel : regler la maison, capturer, verifier que la scene
 * ne touche QUE ce qu'on a choisi.
 */
import { chromium } from 'playwright';

import { connecterNavigateur, ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
const { jeton } = await ouvrirSession();

const B = 'http://localhost:3001';
const j = async (u, o) => { const r = await fetch(B + u, o); return [r.status, await r.json().catch(() => null)]; };
const cmd = (id, c) => fetch(`${B}/api/devices/${id}/command`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) });
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise(r => setTimeout(r, ms));

// --- 1. on regle la maison comme on la veut ---
//
// On attend d'abord que le serveur soit POSE. Le test precedent finit par
// enregistrer une configuration, ce qui recharge le cerveau et remet les etats
// a plat ; des commandes envoyees pendant ce rechargement sont ecrasees. C'est
// ce qui faisait echouer ce test une fois sur dix, en suite complete
// seulement : jamais lance seul.
await pause(2000);

// Les lampes seules sont reessayees : un volet met vingt secondes a parcourir
// sa course, et lui renvoyer un ordre en cours de route le fait repartir de
// zero. On les lance une fois, et on laisse la pause de 24 s faire son office.
const allumerCuisine = async () => {
  await cmd('z01.light.plafond', { kind: 'switch', state: true });
  await cmd('z01.light.plan-travail', { kind: 'dim', level: 40 });
};
await cmd('z07.cover.volet', { kind: 'cover', position: 100 });   // chambre 1 ouverte
await cmd('z08.cover.volet', { kind: 'cover', position: 0 });     // chambre 2 fermee

/** Vrai quand le plan de travail est bien a 40 % : la preuve que ca a pris. */
const pose = async () => {
  const [, st] = await j('/api/state');
  const e = st?.states?.find((x) => x.id === 'z01.light.plan-travail');
  return e?.caps?.find((c) => c.kind === 'dim')?.level === 40
    && e?.caps?.find((c) => c.kind === 'switch')?.state === true;
};

await allumerCuisine();
for (let i = 0; i < 10 && !(await pose()); i++) {
  await pause(1000);
  await allumerCuisine();
}
if (!(await pose())) ok(false, "La maison n'a pas pris le réglage de départ");

await pause(24000);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 1000 } });
await connecterNavigateur(p, jeton);
const err = [];
p.on('pageerror', e => err.push(e.message));

// Les scenes ont quitte le parametrage pour leur propre ecran : un geste
// quotidien n'a rien a faire a cote des identifiants de broker.
await p.goto('http://localhost:5173/scenarios', { waitUntil: 'networkidle' });
await p.waitForTimeout(1800);
// Une carte de scenario est un <article> ; la .card est l'editeur de droite.
ok(await p.locator('main article').count() > 0,
   `Écran Scénarios : ${await p.locator('main article').count()} scénarios existants`);

// --- 2. creer une scene vide ---
const avant = await p.locator('main article').count();
await p.click('button:has-text("+ Nouveau scénario")');
await p.waitForTimeout(600);
ok(await p.locator('main article').count() === avant + 1, 'Nouveau scénario créé, vide');

// L'editeur est le panneau de droite : il porte toujours le scenario choisi,
// et creer un scenario le selectionne.
const fiche = p.locator('aside .card').last();
await fiche.locator('input[aria-label="Nom de la scène"]').fill('Cuisine du matin');

// --- 3. ajouter UNIQUEMENT la cuisine : c'est tout l'enjeu ---
await fiche.locator('button:has-text("+ Ajouter des équipements")').click();
await p.waitForTimeout(400);
await fiche.locator('select').selectOption({ label: 'Cuisine' });
await p.waitForTimeout(500);
await fiche.locator('button:has-text("Ajouter toute la pièce")').click();
await p.waitForTimeout(500);

const lignes = await fiche.locator('.bg-surface .truncate').allTextContents();
// La cuisine n'a pas de volet roulant : juste une porte, qui en recevra un
// plus tard. Deux éclairages, donc.
ok(lignes.length === 2, `${lignes.length} équipements de la cuisine ajoutés : ${lignes.join(', ')}`);

// la valeur capturee doit refleter l'etat reel (plan de travail a 40 %)
const valeurs = await fiche.locator('[class*="text-glow"]').allTextContents();
ok(valeurs.some(v => v.includes('40')), `Valeur capturée sur l'état réel : ${valeurs.map(v => v.trim()).join(' · ')}`);

// --- 4. enregistrer ---
await p.click('button:has-text("Enregistrer")');
await p.waitForTimeout(2500);

const [, cfg] = await j('/api/config');
const scene = cfg.scenes.find(s => s.label === 'Cuisine du matin');
ok(!!scene, 'Scène enregistrée côté serveur');
ok(scene?.actions.every(a => a.deviceId.startsWith('z01.')),
   `La scène ne contient QUE la cuisine (${scene?.actions.length} actions)`);

// --- 5. LE point : jouer la scene ne doit toucher a rien d'autre ---
await cmd('z01.light.plafond', { kind: 'switch', state: false });
await cmd('z07.cover.volet', { kind: 'cover', position: 0 });   // on ferme la chambre 1
await pause(24000);

await j(`/api/scenes/${scene.id}/apply`, { method: 'POST' });
await pause(1500);

const [, st] = await j('/api/state');
const lu = id => st.states.find(s => s.id === id);
ok(lu('z01.light.plafond')?.caps[0]?.state === true, 'La scène a bien rallumé la cuisine');
ok(lu('z07.cover.volet')?.caps[0]?.position === 0,
   `La chambre 1 n'a PAS été touchée (position ${lu('z07.cover.volet')?.caps[0]?.position})`);

// --- menage ---
cfg.scenes = cfg.scenes.filter(s => s.id !== scene.id);
await j('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });

console.log('\nerreurs page :', err.length ? err.slice(0, 3).join(' | ') : 'aucune');
await b.close();
process.exit(process.exitCode ?? 0);
