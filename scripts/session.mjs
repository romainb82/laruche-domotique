/**
 * De quoi faire entrer les scripts de vérification dans la maison.
 *
 * Depuis que le serveur exige un compte, les onze scripts qui appellent
 * `localhost:3001` reçoivent un 401. Plutôt que d'ouvrir une porte dérobée
 * dans le serveur : une variable du genre `AUTH=off`, qui finirait un jour en
 * production : les scripts se connectent comme n'importe qui.
 *
 * Deux cas, traités tout seuls :
 *   · base vierge → le script crée le premier compte ;
 *   · base déjà installée → il se connecte avec les identifiants donnés.
 *
 * Les identifiants viennent de l'environnement. Les valeurs de repli ne
 * servent qu'au développement, sur une base jetable :
 *
 *   RUCHE_IDENT=romain RUCHE_MDP='ma phrase à moi' npm run verifier
 */

const IDENT = process.env.RUCHE_IDENT ?? 'verif';
const MDP = process.env.RUCHE_MDP ?? 'douze abeilles au grenier';

/**
 * Ouvre une session et ajoute l'en-tête à TOUS les appels suivants.
 *
 * On enveloppe `fetch` plutôt que de modifier onze scripts ligne à ligne :
 * chacun n'a qu'un import à ajouter, et le jour où l'authentification change,
 * il n'y a qu'un endroit à reprendre.
 */
export async function ouvrirSession(base = 'http://localhost:3001') {
  const brut = globalThis.fetch;

  const etat = await brut(`${base}/api/auth/etat`)
    .then((r) => r.json())
    .catch(() => null);

  if (!etat) {
    console.error(`\n[session] ${base} ne répond pas. Le serveur tourne-t-il ?\n`);
    process.exit(1);
  }

  const route = etat.installe ? '/api/auth/login' : '/api/auth/premier-compte';
  const corps = etat.installe
    ? { identifiant: IDENT, motDePasse: MDP }
    : { identifiant: IDENT, nom: 'Vérification', motDePasse: MDP };

  const r = await brut(base + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Sans cet en-tete, chaque passage ouvrait une session « Appareil
      // inconnu », et la liste des appareils de la personne se remplissait de
      // centaines de lignes illisibles.
      'user-agent': 'LaRucheVerification/1',
    },
    body: JSON.stringify(corps),
  });
  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    console.error(
      `\n[session] connexion refusée : ${d.error ?? r.status}\n` +
        `          Donnez les identifiants d'un compte existant :\n` +
        `          RUCHE_IDENT=<identifiant> RUCHE_MDP=<mot de passe> npm run verifier\n`,
    );
    process.exit(1);
  }

  const jeton = d.jeton;

  globalThis.fetch = (url, options = {}) => {
    const entetes = new Headers(options.headers ?? {});
    // On n'écrase jamais un en-tête posé par le script : certains vérifient
    // justement ce qui se passe avec un jeton absent ou faux.
    if (!entetes.has('authorization')) entetes.set('authorization', `Bearer ${jeton}`);
    return brut(url, { ...options, headers: entetes });
  };

  return { jeton, compte: d.compte };
}

/**
 * Fait entrer un NAVIGATEUR Playwright dans la maison.
 *
 * Envelopper `fetch` ne suffit pas pour les quatre scripts qui pilotent un
 * vrai navigateur : celui-ci a son propre magasin de cookies, et sans session
 * il tombe sur la page de connexion au lieu de l'ecran a verifier.
 *
 * On pose directement le cookie plutot que de remplir le formulaire : le but
 * de ces scripts est de verifier les ecrans de la maison, pas de rejouer la
 * connexion a chaque fois : `verifier-comptes.mjs` s'en charge, lui, et pour
 * de bon.
 */
export async function connecterNavigateur(page, jeton, hotes = ['localhost', '127.0.0.1']) {
  await page.context().addCookies(
    hotes.map((domain) => ({
      name: 'ruche_session',
      value: jeton,
      domain,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    })),
  );
}
