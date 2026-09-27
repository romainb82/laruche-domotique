/**
 * Le parcours complet, tel qu'un humain le vivra :
 * brancher un vrai module depuis l'interface, sans jamais toucher au code.
 */
import Aedes from 'aedes';
import { createServer } from 'node:net';
import mqtt from 'mqtt';
import { chromium } from 'playwright';

const PORT = 18831;
const aedes = new Aedes();
const srv = createServer(aedes.handle);
await new Promise((r) => srv.listen(PORT, r));
const module_ = mqtt.connect(`mqtt://localhost:${PORT}`);
await new Promise((r) => module_.on('connect', r));

// Menage : les executions precedentes laissent des canaux et des
// raccordements. Un test qui depend de son propre passe n'est pas un test.
{
  const r = await fetch('http://localhost:3001/api/config');
  const cfg = await r.json();
  cfg.connections = cfg.connections.filter((c) => c.kind === 'sim');
  cfg.devices = cfg.devices.map((d) => ({ ...d, binding: null }));
  await fetch('http://localhost:3001/api/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
  });
  await new Promise((r) => setTimeout(r, 1200));
}

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 1000 } });
const err = [];
p.on('pageerror', (e) => err.push(e.message));
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };

await p.goto('http://localhost:5173/parametrage', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

// 1. ajouter un canal MQTT depuis l'interface
await p.click('main nav button:has-text("Matériel")');
await p.waitForTimeout(600);
await p.click('button:has-text("+ Broker MQTT")');
await p.waitForTimeout(500);
const carte = p.locator('.card', { hasText: 'Broker MQTT' }).first();
await carte.locator('input[placeholder^="mqtt://"]').fill(`mqtt://localhost:${PORT}`);
await carte.locator('input[placeholder="domo"]').fill('maison');
ok(await carte.count() > 0, 'Interface : canal MQTT ajoute et renseigne');

// 2. essai a blanc AVANT d'enregistrer
await carte.locator('button:has-text("Tester")').click();
await p.waitForTimeout(2500);
const verdict = await carte.locator('p.bg-ok\\/10, p.bg-crit\\/10').first().textContent().catch(() => null);
ok(verdict?.includes('Répond'), `Essai a blanc avant enregistrement : ${verdict?.trim()}`);

// 3. activer + enregistrer
await carte.locator('input[type=checkbox]').check();
await p.click('button:has-text("Enregistrer")');
await p.waitForTimeout(2500);
const etat = await carte.locator('span:has-text("connecté")').count();
ok(etat > 0, 'Canal enregistre et connecte');

// 4. le module se met a parler -> il doit apparaitre en decouverte
await module_.publishAsync('maison/lampe-salon/status/switch:0', JSON.stringify({ output: false, apower: 0 }));
await p.waitForTimeout(5000);
const decouvert = await p.locator('p.font-mono:has-text("lampe-salon")').count();
ok(decouvert > 0, 'Decouverte : le module apparait sans qu on ait rien saisi');

// 5. le cabler via un pre-reglage
await p.click('main nav button:has-text("Équipements")');
await p.waitForTimeout(800);
// Le nom vit dans un champ de saisie, pas dans le texte : on filtre d'abord
// sur la zone, puis on prend la fiche par son rang.
// On selectionne par IDENTIFIANT de zone, pas par libelle : le libelle porte
// le nombre d'equipements, donc il change des qu'on en ajoute ou en retire.
await p.locator('main section select').first().selectOption('z01');
await p.waitForTimeout(700);
const fiches = p.locator('main .card');
let idx = -1;
for (let i = 0; i < await fiches.count(); i++) {
  const v = await fiches.nth(i).locator('input.font-mono').first().inputValue().catch(() => '');
  if (v === 'z01.light.plafond') { idx = i; break; }
}
if (idx < 0) throw new Error('fiche z01.light.plafond introuvable');
const fiche = fiches.nth(idx);
await fiche.scrollIntoViewIfNeeded();
await fiche.locator('button:has-text("Raccorder à un canal")').click();
await p.waitForTimeout(400);
await fiche.locator('select').filter({ hasText: 'Câblage manuel' }).selectOption({ label: 'Shelly — relais (Gen 2/3)' });
await p.waitForTimeout(400);
await fiche.locator('input[placeholder="identifiant du module"]').fill('lampe-salon');
await fiche.locator('button:has-text("Appliquer")').click();
await p.waitForTimeout(400);
const source = await fiche.locator('input[placeholder="topic ou point d\'entrée"]').first().inputValue();
ok(source === 'lampe-salon/status/switch:0', `Pre-reglage applique : ${source}`);

await p.click('button:has-text("Enregistrer")');
await p.waitForTimeout(2500);

// 6. le vrai module pilote l'affichage
await module_.publishAsync('maison/lampe-salon/status/switch:0', JSON.stringify({ output: true }));
await p.waitForTimeout(1500);
await p.goto('http://localhost:5173/zone/z01', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const allumee = await p.locator('[aria-pressed="true"]').count();
ok(allumee > 0, 'Le vrai module allume la lampe dans l interface');

// 7. et l'interface pilote le vrai module
const ordres = [];
await module_.subscribeAsync('maison/lampe-salon/rpc');
module_.on('message', (t, m) => ordres.push(m.toString()));
await p.locator('[aria-pressed="true"]').first().click();
await p.waitForTimeout(1500);
ok(ordres.some((o) => o.includes('Switch.Set')), `L interface pilote le vrai module : ${ordres[0]}`);

// Menage de sortie : sans lui, la maison reste raccordee a un broker qui
// n'existe plus, et toutes les suites suivantes echouent sur « non connecte ».
{
  const cfg = await (await fetch('http://localhost:3001/api/config')).json();
  cfg.connections = cfg.connections.filter((c) => c.kind === 'sim');
  cfg.devices = cfg.devices.map((d) => ({ ...d, binding: null }));
  await fetch('http://localhost:3001/api/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
  });
  await new Promise((r) => setTimeout(r, 1200));
}

console.log('\nerreurs page :', err.length ? err.slice(0, 3).join(' | ') : 'aucune');
await b.close();
module_.end(true);
srv.closeAllConnections?.(); srv.close();
await new Promise((r) => aedes.close(r));
process.exit(process.exitCode ?? 0);
