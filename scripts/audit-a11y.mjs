/**
 * Audit d'accessibilite mesure, sur l'application en fonctionnement.
 *
 * Complementaire a une revue de code : axe-core evalue le DOM reellement
 * produit, donc il voit ce que le code seul ne montre pas : contrastes
 * calcules, ordre de tabulation, roles effectifs.
 *
 * On mesure aussi deux choses qu'axe ne couvre pas et qui comptent ici :
 * la taille des cibles tactiles (WCAG 2.2, critere 2.5.8) et l'atteignabilite
 * au clavier des controles gestuels.
 */
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

import { connecterNavigateur, ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
const { jeton } = await ouvrirSession();

const BASE = 'http://localhost:5173';

/**
 * Les ecrans mesures.
 *
 * `onglet` fait cliquer un onglet du parametrage avant de mesurer. Sans ca
 * l'audit ne voyait que le premier onglet et se declarait satisfait : les
 * scenes, les zones et le materiel n'etaient jamais regardes. Un audit qui ne
 * visite qu'un tiers des ecrans est pire que pas d'audit, parce qu'il rassure.
 */
const ECRANS = [
  { nom: 'Accueil', url: '/' },
  { nom: 'Pièce (salon)', url: '/zone/z03' },
  // Audité même quand il est retiré du menu : l'adresse reste valable, donc
  // l'écran reste atteignable, donc il doit rester accessible.
  { nom: 'Énergie', url: '/energie' },
  { nom: 'Paramétrage', url: '/parametrage' },
  { nom: 'Scénarios', url: '/scenarios' },
  { nom: 'Zones', url: '/parametrage', onglet: 'Zones' },
  { nom: 'Équipements', url: '/parametrage', onglet: 'Équipements' },
  { nom: 'Matériel', url: '/parametrage', onglet: 'Matériel' },
  { nom: 'Sécurité', url: '/securite' },
  { nom: 'Réglage caméras', url: '/parametrage', onglet: 'Caméras' },
  // La seule page qu'on voit AVANT d'avoir un compte. Elle merite l'audit
  // autant que les autres : c'est celle que tout le monde traverse, et la
  // seule ou du texte clair se pose sur un fond sombre.
  { nom: 'Connexion', url: '/connexion', sansSession: true },
];

const TAILLES = [
  { nom: 'téléphone', width: 390, height: 844 },
  { nom: 'bureau', width: 1512, height: 1000 },
];

/** Le minimum WCAG 2.2 pour une cible tactile, en pixels CSS. */
const CIBLE_MIN = 24;

const navigateur = await chromium.launch();
const bilan = [];

for (const taille of TAILLES) {
  // axe exige une page issue d'un contexte explicite : il injecte son moteur
  // dans toutes les frames et a besoin du contexte pour les atteindre.
  const contexte = await navigateur.newContext({
    viewport: { width: taille.width, height: taille.height },
  });
  const pageConnectee = await contexte.newPage();
  await connecterNavigateur(pageConnectee, jeton);

  // La page de connexion s'audite SANS session : avec le cookie, la garde du
  // routeur renvoie aussitot vers l'accueil, et on auditerait l'accueil deux
  // fois en croyant verifier la connexion.
  const anonyme = await navigateur.newContext({
    viewport: { width: taille.width, height: taille.height },
  });
  const pageAnonyme = await anonyme.newPage();

  let page;
  for (const ecran of ECRANS) {
    page = ecran.sansSession ? pageAnonyme : pageConnectee;
    await page.goto(BASE + ecran.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);

    if (ecran.onglet) {
      await page.getByRole('button', { name: ecran.onglet, exact: true }).first().click();
      await page.waitForTimeout(900);
    }

    // --- axe-core, sur les regles WCAG 2.0/2.1/2.2 niveau A et AA ---
    const resultat = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    // --- cibles tactiles trop petites (critere 2.5.8) ---
    const petites = await page.evaluate((min) => {
      const cibles = document.querySelectorAll(
        'button, a[href], [role="button"], [role="slider"], input, select, [tabindex]:not([tabindex="-1"])',
      );
      const trop = [];
      /**
       * L'exception « inline » du critere 2.5.8.
       *
       * Un lien pose AU MILIEU d'une phrase est explicitement exempte par la
       * norme : sa hauteur est celle de la ligne de texte qui l'entoure, et
       * l'agrandir casserait le paragraphe. On le reconnait a ce que son
       * parent porte du texte en plus du lien lui-meme.
       *
       * Sans cette exception l'audit exigeait d'epaissir « En ajouter » au
       * milieu d'une phrase, ce qui aurait degrade la page pour satisfaire une
       * regle qui ne s'y applique pas.
       */
      const dansUnePhrase = (el) => {
        if (el.tagName !== 'A') return false;
        const parent = el.parentElement;
        if (!parent) return false;
        const autour = (parent.textContent ?? '').replace(el.textContent ?? '', '').trim();
        return autour.length > 0;
      };

      for (const el of cibles) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // masqué : hors sujet
        if (dansUnePhrase(el)) continue;
        if (r.width < min || r.height < min) {
          trop.push({
            balise: el.tagName.toLowerCase(),
            role: el.getAttribute('role') ?? '',
            texte: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
            taille: `${Math.round(r.width)}×${Math.round(r.height)}`,
          });
        }
      }
      return trop;
    }, CIBLE_MIN);

    // --- ce qui est atteignable au clavier ---
    const clavier = await page.evaluate(() => {
      const focusables = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
      );
      const controles = document.querySelectorAll('[role="button"], [role="slider"], button, input[type="range"]');
      let sansFocus = 0;
      for (const c of controles) {
        const t = c.getAttribute('tabindex');
        const natif = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(c.tagName);
        if (!natif && (t === null || t === '-1')) sansFocus++;
      }
      return { focusables: focusables.length, controles: controles.length, sansFocus };
    });

    // --- regions live : les changements d'etat sont-ils annonces ? ---
    const live = await page.locator('[aria-live], [role="status"], [role="alert"]').count();

    bilan.push({
      ecran: ecran.nom,
      taille: taille.nom,
      largeur: taille.width,
      violations: resultat.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        noeuds: v.nodes.length,
        exemple: v.nodes[0]?.html?.slice(0, 110) ?? '',
        cible: v.nodes[0]?.target?.join(' ') ?? '',
      })),
      petitesCibles: petites,
      clavier,
      regionsLive: live,
    });
  }
  await page.close();
  await contexte.close();
}

await navigateur.close();

// ------------------------------------------------------------------- rapport

const parRegle = new Map();
for (const b of bilan) {
  for (const v of b.violations) {
    const e = parRegle.get(v.id) ?? { ...v, ecrans: new Set(), total: 0 };
    e.ecrans.add(`${b.ecran} (${b.taille})`);
    e.total += v.noeuds;
    parRegle.set(v.id, e);
  }
}

const ordre = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const regles = [...parRegle.values()].sort(
  (a, b) => (ordre[a.impact] ?? 9) - (ordre[b.impact] ?? 9) || b.total - a.total,
);

console.log('=== VIOLATIONS axe-core (WCAG 2.2 AA) ===');
if (!regles.length) console.log('  aucune');
for (const r of regles) {
  console.log(`\n  [${(r.impact ?? '?').toUpperCase()}] ${r.id} : ${r.total} élément(s)`);
  console.log(`    ${r.description}`);
  console.log(`    écrans : ${[...r.ecrans].join(', ')}`);
  if (r.cible) console.log(`    ex. : ${r.cible}`);
  if (r.exemple) console.log(`          ${r.exemple.replace(/\s+/g, ' ')}`);
}

console.log('\n=== CIBLES TACTILES sous 24×24 px (WCAG 2.2 : 2.5.8) ===');
const vues = new Set();
let petites = 0;
for (const b of bilan.filter((x) => x.largeur === 390)) {
  for (const p of b.petitesCibles) {
    const cle = `${p.balise}|${p.texte}|${p.taille}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    petites++;
    console.log(`  ${p.taille.padEnd(9)} <${p.balise}${p.role ? ` role=${p.role}` : ''}> ${p.texte || '(sans nom)'}`);
  }
}
if (!petites) console.log('  aucune : toutes les cibles atteignent le minimum');

console.log('\n=== CLAVIER ET ANNONCES ===');
for (const b of bilan.filter((x) => x.largeur === 390)) {
  console.log(
    `  ${b.ecran.padEnd(15)} ${String(b.clavier.focusables).padStart(3)} éléments focusables · ` +
      `${b.clavier.sansFocus} contrôle(s) hors du clavier · ${b.regionsLive} région(s) live`,
  );
}

const graves = regles.filter((r) => r.impact === 'critical' || r.impact === 'serious').length;
console.log(`\n=== BILAN : ${regles.length} règle(s) en échec, dont ${graves} grave(s) ; ${petites} cible(s) trop petite(s) ===`);
// Un audit qui ne peut pas échouer n'audite rien : une violation grave ou une
// cible trop petite fait tomber la commande, comme n'importe quelle suite.
process.exit(graves || petites ? 1 : 0);
