/**
 * Trois comptes de demonstration, un par role.
 *
 * De quoi voir TOUS les ecrans sans attendre d'avoir de vrais habitants :
 * la page de connexion avec plusieurs visages, le rail avec l'initiale, les
 * Reglages avec la liste des comptes, et surtout ce qu'un invite ne voit pas.
 *
 * Les mots de passe sont ecrits en clair ci-dessous, et c'est assume : ce sont
 * des comptes de demonstration pour une base de developpement. Ne JAMAIS les
 * laisser sur la machine de la maison. Le script le rappelle a la fin.
 *
 *   npm run comptes:demo                cree les trois comptes
 *   npm run comptes:demo -- --retirer   les supprime
 */
import { ouvrirSession } from './session.mjs';

const B = 'http://localhost:3001';

const DEMO = [
  { identifiant: 'romain', nom: 'Romain', role: 'admin', motDePasse: 'les abeilles du grenier' },
  { identifiant: 'melissa', nom: 'Mélissa', role: 'habitant', motDePasse: 'le jardin en septembre' },
  { identifiant: 'invite', nom: 'Invité', role: 'invite', motDePasse: 'bonjour la maisonnee' },
];

const retirer = process.argv.includes('--retirer');

await ouvrirSession(B);

const { comptes } = await (await fetch(`${B}/api/comptes`)).json();
const parIdentifiant = new Map(comptes.map((c) => [c.identifiant, c]));

if (retirer) {
  for (const d of DEMO) {
    const existant = parIdentifiant.get(d.identifiant);
    if (!existant) {
      console.log(`  ·  ${d.identifiant} : absent`);
      continue;
    }
    const r = await fetch(`${B}/api/comptes/${existant.id}`, { method: 'DELETE' });
    const corps = await r.json().catch(() => ({}));
    console.log(r.ok ? `  ✓  ${d.identifiant} supprime` : `  ✗  ${d.identifiant} : ${corps.error}`);
  }
  process.exit(0);
}

for (const d of DEMO) {
  if (parIdentifiant.has(d.identifiant)) {
    console.log(`  ·  ${d.identifiant} existe deja`);
    continue;
  }
  const r = await fetch(`${B}/api/comptes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(d),
  });
  const corps = await r.json().catch(() => ({}));
  console.log(
    r.ok ? `  ✓  ${d.nom} (${d.role})` : `  ✗  ${d.identifiant} : ${corps.error ?? r.status}`,
  );
}

console.log('\nPour se connecter :');
for (const d of DEMO) console.log(`  ${d.identifiant.padEnd(9)} ${d.motDePasse}`);
console.log(
  '\nCe sont des comptes de DEMONSTRATION, avec des mots de passe publics.\n' +
    'Sur la machine de la maison :  npm run comptes:demo -- --retirer\n',
);
