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
  if (!etat.installe) {
    console.warn(
      `\n[session] ATTENTION : la base était vierge, le script vient de créer l'administrateur « ${IDENT} »\n` +
        `          avec un mot de passe PUBLIC. Ne lancez jamais la vérification sur la machine de la maison\n` +
        `          avant d'y avoir créé votre propre compte ; sinon supprimez ce compte depuis Réglages → Comptes.\n`,
    );
  }

  globalThis.fetch = (url, options = {}) => {
    const entetes = new Headers(options.headers ?? {});
    // On n'écrase jamais un en-tête posé par le script : certains vérifient
    // justement ce qui se passe avec un jeton absent ou faux.
    if (!entetes.has('authorization')) entetes.set('authorization', `Bearer ${jeton}`);
    return brut(url, { ...options, headers: entetes });
  };

  await protegerLaMaison(base);

  return { jeton, compte: d.compte };
}

/**
 * La maison d'avant, remise telle quelle à la sortie.
 *
 * Les scripts de vérification réécrivent la configuration (canaux d'essai,
 * équipements `test.*`, scènes) et faisaient leur ménage en remettant les
 * équipements SANS raccordement : lancés une fois contre une maison
 * configurée, ils effaçaient tous les raccordements. Et une exception avant
 * le ménage laissait la maison en état de test.
 *
 * Désormais : on photographie la configuration ENTIÈRE à l'entrée, on la
 * remet à l'identique à la sortie, quelle que soit la sortie (`process.exit`,
 * exception, promesse rejetée), et on ferme la session ouverte par le script.
 *
 * Et avant tout ça, un garde-fou : contre une maison qui a de vrais
 * raccordements, de vrais canaux ou des caméras, le script refuse de tourner
 * sans `RUCHE_VERIF_OK=1`. Une base de développement n'a rien de tout ça.
 */
async function protegerLaMaison(base) {
  const cfg0 = await fetch(`${base}/api/config`).then((r) => r.json()).catch(() => null);
  if (!cfg0 || !cfg0.devices) return; // compte sans droit de lecture complète : rien à protéger

  const raccordes = cfg0.devices.filter((d) => d.binding && d.binding.connectionId !== 'sim').length;
  const canaux = (cfg0.connections ?? []).filter((c) => c.kind !== 'sim' && c.enabled).length;
  const cameras = (cfg0.cameras ?? []).length;
  if ((raccordes || canaux || cameras) && process.env.RUCHE_VERIF_OK !== '1') {
    console.error(
      `\n[session] Cette maison a l'air d'être la VRAIE : ${raccordes} raccordement(s), ${canaux} canal(aux) actif(s), ${cameras} caméra(s).\n` +
        `          Les scripts de vérification réécrivent la configuration. Pour insister : RUCHE_VERIF_OK=1\n`,
    );
    process.exit(1);
  }

  const photo = JSON.stringify(cfg0);
  let fait = false;
  const sortie = process.exit.bind(process);

  async function restaurer() {
    if (fait) return;
    fait = true;
    try {
      const actuel = await fetch(`${base}/api/config`).then((r) => r.json());
      if (JSON.stringify(actuel) !== photo) {
        const r = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: photo,
        });
        if (!r.ok) console.error(`[session] la maison n'a pas pu être remise en état : ${r.status}`);
      }
      await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    } catch (e) {
      console.error(`[session] remise en état impossible : ${e.message}`);
    }
  }

  // Toute sortie passe par ici : la fin normale du script, comme ses échecs.
  process.exit = (code) => {
    void restaurer().then(() => sortie(code ?? process.exitCode ?? 0));
  };
  process.on('uncaughtException', (e) => {
    console.error(e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error(e);
    process.exit(1);
  });
  process.on('beforeExit', () => {
    if (!fait) process.exit(process.exitCode ?? 0);
  });
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
