/**
 * Les comptes, mis a l'epreuve.
 *
 * Ce script lance son PROPRE serveur, sur une base vierge et jetable. Les onze
 * autres parlent au serveur de developpement ; celui-ci ne peut pas, parce
 * qu'il doit observer une maison ou aucun compte n'existe encore : ce qui
 * n'arrive qu'une fois dans la vie d'une installation.
 *
 * Ce qui est verifie ici et nulle part ailleurs :
 *   · une route protegee refuse un inconnu, et le dit en 401 ;
 *   · le premier compte ne peut etre cree qu'UNE fois ;
 *   · un identifiant inconnu et un mot de passe faux donnent le MEME message
 *     et le MEME temps de reponse, sinon on apprend qui habite la maison ;
 *   · cinq essais rates ferment le guichet ;
 *   · aucun jeton ni mot de passe n'est stocke en clair dans la base ;
 *   · on ne peut pas se retirer soi-meme ses droits d'administrateur.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3096;
const B = `http://127.0.0.1:${PORT}`;
const RACINE = fileURLToPath(new URL('..', import.meta.url));
const ATELIER = mkdtempSync(join(tmpdir(), 'ruche-comptes-'));

const MDP = 'quinze abeilles au grenier';
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Appel brut : aucun en-tete n'est ajoute dans notre dos. */
async function j(chemin, options = {}) {
  const r = await fetch(B + chemin, options);
  return [r.status, await r.json().catch(() => null), r.headers];
}
const post = (u, corps, entetes = {}) =>
  j(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...entetes },
    body: JSON.stringify(corps),
  });

// --------------------------------------------------------------- le serveur

const serveur = spawn('node', [join(RACINE, 'packages/server/dist/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE: join(ATELIER, 'essai.db'),
    HOMEKIT_DIR: join(ATELIER, 'homekit'),
    BONJOUR: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let sorties = '';
serveur.stdout.on('data', (d) => { sorties += d; });
serveur.stderr.on('data', (d) => { sorties += d; });

function rangerEtSortir() {
  serveur.kill();
  rmSync(ATELIER, { recursive: true, force: true });
}
process.on('exit', rangerEtSortir);

for (let i = 0; i < 80; i++) {
  try { await fetch(`${B}/api/auth/etat`); break; } catch { await pause(250); }
}

// ============================================================= maison neuve

{
  const [, d] = await j('/api/auth/etat');
  ok(d?.installe === false, `Maison neuve : aucun compte (installe = ${d?.installe})`);
  ok(d?.compte === null, "Personne n'est connecte");
  // La page de connexion s'affiche avant toute authentification : elle ne doit
  // donc RIEN apprendre sur la maison a qui la regarde.
  ok(
    !JSON.stringify(d).match(/ruche|jourdanelle|aussillon|zone/i),
    `L'etat d'ouverture ne dit rien de la maison : ${JSON.stringify(d)}`,
  );
}

{
  const [s] = await j('/api/state');
  ok(s === 401, `Une route protegee refuse un inconnu : ${s}`);
  const [s2] = await j('/api/cameras');
  ok(s2 === 401, `Les cameras aussi : ${s2}`);
}

// ========================================================= le premier compte

{
  const [s, d] = await post('/api/auth/premier-compte', { identifiant: 'ro', nom: 'R', motDePasse: MDP });
  ok(s === 400 && /3 caract/.test(d?.error ?? ''), `Identifiant trop court refuse : ${d?.error}`);
}
{
  const [s, d] = await post('/api/auth/premier-compte', { identifiant: 'romain', nom: 'Romain', motDePasse: 'court' });
  ok(s === 400 && /12 caract/.test(d?.error ?? ''), `Mot de passe trop court refuse : ${d?.error}`);
}
{
  // La maison s'appelle La Ruche : c'est exactement le mot de passe que
  // quelqu'un choisirait, et exactement celui qu'un voisin essaierait.
  const [s, d] = await post('/api/auth/premier-compte', {
    identifiant: 'romain', nom: 'Romain', motDePasse: 'la ruche de 2026',
  });
  ok(s === 400, `Un mot de passe trop evident est refuse : ${d?.error}`);
}

let cookie = null;
let jeton = null;
{
  const [s, d, h] = await post('/api/auth/premier-compte', { identifiant: 'romain', nom: 'Romain', motDePasse: MDP });
  ok(s === 200 && d?.compte?.identifiant === 'romain', `Premier compte cree : ${d?.compte?.identifiant}`);
  ok(d?.compte?.role === 'admin', `Le premier compte est administrateur : ${d?.compte?.role}`);
  const entete = h.get('set-cookie') ?? '';
  cookie = entete.split(';')[0];
  jeton = d?.jeton;
  ok(cookie.startsWith('ruche_session='), 'Le cookie de session est pose');
  ok(/HttpOnly/i.test(entete), 'Le cookie est HttpOnly : JavaScript ne peut pas le lire');
  ok(!/Secure/i.test(entete), 'Pas de Secure en HTTP simple, sinon le cookie ne reviendrait jamais');
}

{
  const [s, d] = await post('/api/auth/premier-compte', {
    identifiant: 'pirate', nom: 'P', motDePasse: 'bonjour les gens ici',
  });
  ok(s === 409, `Un SECOND premier compte est refuse : ${s} ${d?.error ?? ''}`);
}

// ============================================================ les deux entrees

{
  const [s] = await j('/api/state', { headers: { cookie } });
  ok(s === 200, `Route protegee avec le cookie : ${s}`);
}
{
  const [s] = await j('/api/state', { headers: { authorization: `Bearer ${jeton}` } });
  ok(s === 200, `Route protegee avec l'en-tete Bearer (app iOS) : ${s}`);
}
{
  const [s] = await j('/api/state', { headers: { authorization: 'Bearer nimportequoi' } });
  ok(s === 401, `Un jeton invente est refuse : ${s}`);
}

// ============================================================= ne rien reveler

{
  const t0 = Date.now();
  const [s1, d1] = await post('/api/auth/login', { identifiant: 'romain', motDePasse: 'mauvais mot de passe' });
  const dureeConnu = Date.now() - t0;

  const t1 = Date.now();
  const [s2, d2] = await post('/api/auth/login', { identifiant: 'jamaisvu', motDePasse: 'mauvais mot de passe' });
  const dureeInconnu = Date.now() - t1;

  ok(s1 === 401 && s2 === 401, `Les deux refus sont des 401 : ${s1} / ${s2}`);
  ok(d1?.error === d2?.error, `Message identique dans les deux cas : « ${d1?.error} »`);

  // Le leurre fait travailler scrypt meme pour un identifiant inconnu. Sans
  // lui, l'inconnu repondrait en ~1 ms et le connu en plusieurs dizaines : il
  // suffirait de chronometrer pour apprendre qui habite ici. On tolere un
  // facteur 3, les mesures etant bruitees sur une machine chargee.
  const lent = Math.max(dureeConnu, dureeInconnu);
  const vif = Math.max(1, Math.min(dureeConnu, dureeInconnu));
  ok(lent / vif < 3, `Temps comparables : ${dureeConnu} ms (connu) contre ${dureeInconnu} ms (inconnu)`);
}

// =================================================================== la base

{
  // On relit la base : le jeton qui ouvre la session ne doit APPARAITRE NULLE
  // PART. Une sauvegarde oubliee sur une cle USB ne doit donner acces a rien.
  const { default: Database } = await import('better-sqlite3');
  const base = new Database(join(ATELIER, 'essai.db'), { readonly: true });

  const lignes = base.prepare('SELECT empreinte FROM session').all();
  ok(lignes.length > 0, `${lignes.length} session(s) en base`);
  ok(!lignes.some((l) => l.empreinte === jeton), "Le jeton n'est PAS stocke en clair");
  ok(lignes.every((l) => /^[0-9a-f]{64}$/.test(l.empreinte)), 'Seules des empreintes SHA-256 sont stockees');

  const c = base.prepare('SELECT hash FROM compte WHERE identifiant = ?').get('romain');
  ok(!c.hash.includes(MDP), "Le mot de passe n'est PAS stocke en clair");
  ok(c.hash.startsWith('scrypt$'), `Le mot de passe est hache par scrypt : ${c.hash.slice(0, 18)}…`);
  base.close();
}

// ================================================================= les roles

let cookieMelissa = null;
{
  const [s, d] = await post(
    '/api/comptes',
    { identifiant: 'melissa', nom: 'Melissa', motDePasse: 'le jardin et les fleurs', role: 'habitant' },
    { cookie },
  );
  ok(s === 200 && d?.compte?.role === 'habitant', `Un administrateur cree un compte : ${d?.compte?.identifiant}`);

  const [, d2, h2] = await post('/api/auth/login', { identifiant: 'melissa', motDePasse: 'le jardin et les fleurs' });
  cookieMelissa = (h2.get('set-cookie') ?? '').split(';')[0];
  ok(Boolean(d2?.compte), 'Le nouveau compte peut se connecter');
}

{
  const [s] = await j('/api/comptes', { headers: { cookie: cookieMelissa } });
  ok(s === 403, `Un habitant ne voit pas la liste des comptes : ${s}`);
  const [s2] = await j('/api/state', { headers: { cookie: cookieMelissa } });
  ok(s2 === 200, `…mais il pilote bien la maison : ${s2}`);
}

{
  const [, d] = await j('/api/comptes', { headers: { cookie } });
  const moi = d.comptes.find((c) => c.identifiant === 'romain');

  const [s1, e1] = await j(`/api/comptes/${moi.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ role: 'invite' }),
  });
  ok(s1 === 400, `On ne se retire pas ses propres droits : ${s1} : « ${e1?.error ?? ''} »`);

  const [s2, e2] = await j(`/api/comptes/${moi.id}`, { method: 'DELETE', headers: { cookie } });
  ok(s2 === 400, `On ne supprime pas son propre compte : ${s2} : « ${e2?.error ?? ''} »`);
}

{
  // Le compte de Melissa est habitant : le desactiver ne touche pas au seul
  // administrateur, l'operation doit donc passer.
  const [, d] = await j('/api/comptes', { headers: { cookie } });
  const m = d.comptes.find((c) => c.identifiant === 'melissa');

  const [s] = await j(`/api/comptes/${m.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ actif: false }),
  });
  ok(s === 200, `Un administrateur desactive un compte : ${s}`);

  // Et la session de ce compte doit tomber IMMEDIATEMENT. Sinon desactiver
  // quelqu'un n'aurait d'effet qu'a sa prochaine connexion, c'est-a-dire
  // peut-etre jamais.
  const [s2] = await j('/api/state', { headers: { cookie: cookieMelissa } });
  ok(s2 === 401, `La session d'un compte desactive tombe aussitot : ${s2}`);
}

// ================================================================= la sortie

{
  const [s] = await post('/api/auth/logout', {}, { cookie });
  ok(s === 200, `Deconnexion : ${s}`);
  const [s2] = await j('/api/state', { headers: { cookie } });
  ok(s2 === 401, `Le jeton ne vaut plus rien apres la deconnexion : ${s2}`);
}

// ================================================================ le guichet
//
// En DERNIER : une fois le guichet ferme, « romain » ne peut plus se
// connecter pendant quinze minutes. Le placer plus haut condamnerait tout ce
// qui suit.

{
  for (let i = 0; i < 5; i++) await post('/api/auth/login', { identifiant: 'romain', motDePasse: `essai ${i}` });
  const [s, d] = await post('/api/auth/login', { identifiant: 'romain', motDePasse: MDP });
  ok(s === 429, `Cinq essais rates ferment le guichet : ${s} : « ${d?.error ?? ''} »`);
  ok(/minute/.test(d?.error ?? ''), 'Le refus dit combien de temps attendre');
}

if (process.exitCode) console.log(`\n--- journal du serveur ---\n${sorties.slice(-900)}`);
rangerEtSortir();
process.exit(process.exitCode ?? 0);
