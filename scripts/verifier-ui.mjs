import { chromium } from 'playwright';
const b = await chromium.launch();
const err = [];

// --- bureau ---
const p = await b.newPage({ viewport: { width: 1512, height: 950 } });
p.on('pageerror', e => err.push('bureau: ' + e.message));
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const svgB = await p.locator('main svg[role="group"]').boundingBox();
console.log('BUREAU  plan =', Math.round(svgB.width), 'x', Math.round(svgB.height),
            '| viewBox =', await p.locator('main svg[role="group"]').getAttribute('viewBox'));
await p.screenshot({ path: '/tmp/shots/1-accueil.png', fullPage: true });

// --- telephone ---
const m = await b.newPage({ viewport: { width: 390, height: 844 } });
m.on('pageerror', e => err.push('mobile: ' + e.message));
await m.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await m.waitForTimeout(1500);
const svgM = await m.locator('main svg[role="group"]').boundingBox();
const vb = (await m.locator('main svg[role="group"]').getAttribute('viewBox')).split(' ').map(Number);
console.log('MOBILE  plan =', Math.round(svgM.width), 'x', Math.round(svgM.height), '| viewBox =', vb.join(' '));
// echelle = pixels a l'ecran par unite du plan
const echelle = svgM.height / vb[3];
console.log('        echelle =', echelle.toFixed(2), 'px/unite  (avant bascule : 0.60)');
console.log('        nom de piece rendu a ~', (11 * echelle).toFixed(1), 'px');
await m.screenshot({ path: '/tmp/shots/6-mobile.png', fullPage: true });

// le plan reste cliquable apres rotation
await m.locator('main svg g[role="button"]').first().click();
await m.waitForTimeout(1000);
console.log('        clic sur une piece ->', new URL(m.url()).pathname);

console.log('\nerreurs :', err.length ? err.join(' | ') : 'aucune');
await b.close();
