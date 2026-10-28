import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSeedConfig,
  isBlocking,
  migrateConfig,
  validateConfig,
  verifierForme,
  type Command,
  type DeviceConfig,
  PRESETS,
  type Connection,
  type HouseConfig,
  type CameraConfig,
  type SceneConfig,
  type ZoneConfig,
  bornesPeriode,
  integrer,
  repartir,
  pic,
  type Periode,
} from '@domo/shared';
import { Db } from './db.js';
import { StateHub } from './state.js';
import { MqttAdapter } from './adapters/mqtt.js';
import { HttpAdapter } from './adapters/http.js';
import { ModbusAdapter } from './adapters/modbus.js';
import { HomeAssistantAdapter } from './adapters/homeassistant.js';
import type { Adapter } from './adapters/adapter.js';
import { PontHomeKit } from './homekit.js';
import { Planificateur } from './planificateur.js';
import { instantane, publique } from './cameras.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  auMoins,
  normaliserIdentifiant,
  REFUS_CONNEXION,
  ROLES,
  validerIdentifiant,
  validerMotDePasse,
  validerNom,
  type Compte,
  type Role,
} from '@domo/shared';
import {
  empreinteJeton,
  Guichet,
  hacher,
  jetonDeLaRequete,
  nommerAppareil,
  nouveauJeton,
  nouvelId,
  poserCookie,
  retirerCookie,
  SESSION_JOURS,
  verifier,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_FILE = process.env.DB_FILE ?? new URL('../../../data/domotique.db', import.meta.url).pathname;

const db = new Db(DB_FILE);

// Premier démarrage : on sème la maison lue sur le plan, pour que
// l'application ne s'ouvre jamais sur un écran vide.
/**
 * Une configuration qu'on ne peut pas lire ou qui ne tient pas debout ne doit
 * pas empêcher la maison de marcher : on démarre sur la maison de référence
 * SANS l'écrire en base, en le disant très fort. La configuration abîmée
 * reste en base pour être récupérée à la main.
 */
let configDeSecours = false;
let config: HouseConfig;
try {
  const lue = db.loadConfig();
  if (!lue) {
    config = buildSeedConfig();
    db.saveConfig(config);
    console.log('[config] première initialisation : maison de référence chargée');
  } else {
    // Les bases écrites avant le bus d'adaptateurs sont converties au vol.
    const migre = migrateConfig(lue);
    const defaut = verifierForme(migre);
    if (defaut) {
      db.mettreDeCote(JSON.stringify(lue));
      throw new Error(`forme invalide (${defaut}) ; copie rangée dans la table config_abimee`);
    }
    config = migre;
    if (migre !== lue) {
      db.saveConfig(config);
      console.log('[config] migrée vers les connexions multiples');
    }
  }
} catch (e) {
  console.error(`[config] ${(e as Error).message}`);
  console.error('[config] démarrage sur la maison de référence, SANS l’enregistrer : la base est conservée telle quelle.');
  config = buildSeedConfig();
  configDeSecours = true;
}

const hub = new StateHub(config, db);
hub.on('warn', (m: string) => console.warn(`[canal] ${m}`));

try {
  await hub.start();
} catch (e) {
  // Un canal qui fait lever le démarrage (adresse malformée, réglage absent)
  // ne doit pas laisser la maison sans pilotage : on coupe les canaux et on
  // repart en simulé, sans rien écrire. Mieux vaut une maison simulée qu'un
  // serveur qui redémarre en boucle.
  console.error(`[canal] démarrage impossible : ${(e as Error).message}`);
  console.error('[canal] les canaux sont coupés pour ce démarrage ; corrigez le raccordement fautif dans Paramétrage.');
  config = {
    ...config,
    connections: config.connections.map((c) => (c.kind === 'sim' ? c : { ...c, enabled: false })),
  };
  await hub.reload(config);
}
for (const c of hub.connections()) {
  const marque = c.state === 'connected' ? '✓' : c.state === 'disabled' ? '·' : '✗';
  console.log(`[canal] ${marque} ${c.label} : ${c.devices} équipements${c.detail ? ` (${c.detail})` : ''}`);
}

/**
 * Le planificateur : ce qui fait partir une scène toute seule.
 *
 * Il démarre avec le serveur et ne rattrape jamais un départ manqué : un
 * réveil qui s'exécute à 9 h parce que la machine a redémarré agirait sur une
 * situation qui n'existe plus.
 */
const planificateur = new Planificateur(hub, db, (m) => console.warn(m));
planificateur.start(config);
{
  const suivante = planificateur.prochaine();
  const programmees = (config.scenes ?? []).filter(
    (s) => s.enabled && s.trigger?.kind === 'time',
  ).length;
  console.log(
    `[scènes] ${programmees} programmée(s)` +
      (suivante
        ? ` : prochaine : ${suivante.label} à ${new Date(suivante.at).toLocaleString('fr-FR', { timeZone: config.house.timezone })}`
        : ''),
  );
}

/**
 * Le pont HomeKit. Éteint tant que la configuration ne l'allume pas : publier
 * la maison sur le réseau n'est pas une décision à prendre pour quelqu'un.
 */
// Le dossier d'appairage HomeKit est déplaçable, comme la base : installé en
// service, le code vit dans /opt en lecture seule et l'état dans /var/lib.
const HOMEKIT_DIR =
  process.env.HOMEKIT_DIR ?? new URL('../../../data/homekit', import.meta.url).pathname;
const pont = new PontHomeKit(hub, HOMEKIT_DIR);
try {
  await pont.start(config);
  if (config.homekit?.enabled) {
    const e = pont.etat(config);
    console.log(`[homekit] ✓ pont ouvert : ${e.exposes} accessoires` +
      (e.skipped.length ? `, ${e.skipped.length} écarté(s)` : ''));
  }
} catch (e) {
  // Un pont qui refuse de s'ouvrir ne doit pas empêcher la maison de marcher.
  console.warn(`[homekit] ${(e as Error).message}`);
}

/**
 * Le dernier filet.
 *
 * Tout ce qui précède cloisonne ses erreurs ; s'il en reste une qui échappe,
 * on la journalise au lieu de laisser Node tuer le processus. Un serveur qui
 * meurt sur une promesse oubliée, c'est une maison sans pilotage, et systemd
 * qui le relance pour le voir remourir sur le même message.
 */
process.on('unhandledRejection', (raison) => {
  console.error(`[serveur] promesse rejetée sans suite : ${(raison as Error)?.message ?? String(raison)}`);
});
process.on('uncaughtException', (e) => {
  console.error(`[serveur] exception non rattrapée : ${e.stack ?? e.message}`);
});

const app = Fastify({ logger: false });
await app.register(websocket);

// L'interface tourne sur un autre port en développement.
//
// `*` et PAS d'en-tête `Allow-Credentials` : un navigateur refuse de toute
// façon d'envoyer un cookie vers une origine autorisée par `*`. Ce n'est pas
// une limite en pratique : l'interface web est servie par ce serveur ou par le
// mandataire de Vite, donc même origine, et l'application iOS porte son jeton
// dans l'en-tête `Authorization`, auquel le CORS ne s'applique pas.
app.addHook('onSend', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'content-type, authorization');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
});
app.options('/*', async (_req, reply) => reply.status(204).send());

// ============================================================= les comptes
//
// Avant ce chantier, toute machine du réseau local pouvait piloter la maison
// et demander les images des caméras. Deux pièces le corrigent : la garde
// ci-dessous, qui ferme les 35 routes existantes, et les routes `/api/auth`,
// seules à rester ouvertes.

const guichet = new Guichet();

/**
 * Un hachage qui ne correspond à personne.
 *
 * Il sert à faire travailler scrypt exactement aussi longtemps quand
 * l'identifiant est inconnu que lorsqu'il existe. Sans ce leurre, la durée de
 * la réponse trahirait quels comptes existent dans la maison : une attaque
 * classique, et facile à mener depuis le réseau local.
 *
 * Calculé une fois au démarrage, sur une valeur aléatoire que personne ne
 * connaît : il n'y a aucun mot de passe capable de le satisfaire.
 */
const HACHAGE_LEURRE = await hacher(nouveauJeton());

{
  const balayees = db.purgerSessions();
  if (balayees) console.log(`[comptes] ${balayees} session(s) expirée(s) effacée(s)`);
}

/** Le compte derrière la requête courante, posé par la garde. */
declare module 'fastify' {
  interface FastifyRequest {
    compte?: Compte;
    sessionId?: string;
  }
}

/**
 * Ce qui reste accessible sans compte.
 *
 * Volontairement court, et volontairement explicite : une liste d'exceptions
 * qu'on allonge « juste pour essayer » est la façon habituelle dont une
 * authentification finit par ne plus rien protéger.
 *
 * Les fichiers de l'interface n'y figurent pas et n'en ont pas besoin : la
 * garde ne s'applique qu'aux chemins `/api` et `/ws`. Il FAUT que la page de
 * connexion puisse se charger sans être connecté.
 */
const OUVERT = new Set([
  '/api/auth/etat',
  '/api/auth/login',
  '/api/auth/premier-compte',
  '/api/auth/habitants',
]);

/**
 * La liste des habitants s'affiche-t-elle AVANT la connexion ?
 *
 * Oui par défaut : c'est une maison, pas un extranet. Choisir son visage
 * plutôt que taper son identifiant est ce que font macOS, Windows et les
 * consoles de jeu, et c'est le geste naturel sur une tablette fixée au mur.
 *
 * Le prix est réel et doit être dit : qui est sur le réseau local apprend
 * combien de personnes vivent ici et leurs prénoms. Tant qu'on reste sur le
 * Wi-Fi de la maison c'est sans conséquence : ces gens sont déjà chez vous.
 * Le jour où le serveur sortira derrière un tunnel : `HABITANTS=off`.
 *
 * Ce qui n'est JAMAIS rendu, même liste affichée : l'identifiant de connexion.
 * On montre un prénom et un visage, pas de quoi commencer à deviner.
 */
const LISTER_HABITANTS = process.env.HABITANTS !== 'off';

/**
 * La garde. Elle s'exécute avant chaque route.
 *
 * `onRequest` et pas `preHandler` : on refuse avant même que Fastify n'ait lu
 * le corps de la requête, donc sans jamais désérialiser ce qu'envoie un
 * inconnu.
 */
app.addHook('onRequest', async (req, reply) => {
  const chemin = req.url.split('?')[0] ?? '/';
  if (req.method === 'OPTIONS') return;
  if (!chemin.startsWith('/api') && chemin !== '/ws') return;
  if (OUVERT.has(chemin)) return;

  const jeton = jetonDeLaRequete(req.headers.cookie, req.headers.authorization);
  const trouve = jeton ? db.sessionValide(empreinteJeton(jeton)) : null;

  if (!trouve) {
    // 401 et pas 403 : l'interface sait alors qu'il faut rouvrir la page de
    // connexion, au lieu d'afficher « accès refusé » à quelqu'un dont la
    // session a simplement expiré pendant la nuit.
    return reply.status(401).send({ error: 'Connexion requise.' });
  }

  req.compte = trouve.compte;
  req.sessionId = trouve.sessionId;
  db.toucherSession(trouve.sessionId, trouve.vueLe, SESSION_JOURS);

  // Le rang requis se décide ICI, pour toutes les routes à la fois, et non
  // route par route : une route qu'on oublie de protéger est la façon
  // habituelle dont un modèle de rôles finit par ne rien protéger.
  const minimum = rangRequis(req.method, chemin);
  if (minimum && !exige(req, reply, minimum)) return reply;
});

/**
 * Le rang que demande chaque route. Tout ce qui n'est pas listé est ouvert à
 * tout compte connecté : piloter la maison, lire son état, voir les scènes.
 *
 * Les trois promesses de `ROLE_DESCRIPTIONS` se traduisent ainsi :
 *   . `invite` ne voit pas les caméras : tout `/api/cameras` demande `habitant` ;
 *   . `habitant` ne touche ni au matériel ni aux comptes : toute écriture de
 *     configuration, de scène ou de connexion demande `admin` ;
 *   . l'invité « allume les lumières et ouvre les volets » : le thermostat et
 *     les scènes lui sont fermés, ce que vérifient les routes de commande.
 */
function rangRequis(methode: string, chemin: string): Role | null {
  const ecriture = methode !== 'GET' && methode !== 'HEAD';
  if (chemin.startsWith('/api/comptes')) return 'admin';
  if (chemin.startsWith('/api/config')) return ecriture ? 'admin' : null;
  if (chemin.startsWith('/api/connections')) return ecriture ? 'admin' : null;
  if (chemin.startsWith('/api/discovery')) return 'admin';
  if (chemin === '/api/homekit') return 'admin';
  if (chemin === '/api/presets') return 'admin';
  if (chemin === '/api/scenes' || chemin === '/api/scenes/reset') return ecriture ? 'admin' : null;
  if (chemin.startsWith('/api/cameras')) return chemin.endsWith('/test') ? 'admin' : 'habitant';
  return null;
}

/** Refuse la requête si le compte n'a pas le rang demandé. */
function exige(req: FastifyRequest, reply: FastifyReply, minimum: Role): boolean {
  if (req.compte && auMoins(req.compte.role, minimum)) return true;
  reply.status(403).send({ error: "Votre compte n'a pas les droits pour cette action." });
  return false;
}

/** Ce qu'un invité a le droit de piloter : la lumière et les volets, rien d'autre. */
const TYPES_INVITE = new Set<DeviceConfig['type']>(['light', 'dimmer', 'cover']);

/** Vrai si le compte peut envoyer une commande à cet équipement. */
function peutPiloter(compte: Compte, deviceId: string): boolean {
  if (auMoins(compte.role, 'habitant')) return true;
  const device = config!.devices.find((d) => d.id === deviceId);
  return !!device && TYPES_INVITE.has(device.type);
}

/**
 * L'état d'ouverture, avant toute connexion.
 *
 * Ne dit RIEN de la maison : ni son nom, ni ses pièces, ni combien de comptes
 * existent. Seulement s'il faut créer le premier compte ou se connecter : le
 * strict nécessaire pour que la page sache quoi afficher.
 */
app.get('/api/auth/etat', async (req) => {
  const jeton = jetonDeLaRequete(req.headers.cookie, req.headers.authorization);
  const trouve = jeton ? db.sessionValide(empreinteJeton(jeton)) : null;
  return { installe: db.nbComptes() > 0, compte: trouve?.compte ?? null };
});

/**
 * Qui habite ici : prénom et rôle, rien d'autre.
 *
 * Ce qui permet de choisir son visage au lieu de taper un identifiant. Les
 * comptes désactivés n'y figurent pas : proposer quelqu'un dont le compte est
 * fermé, c'est promettre une porte qui ne s'ouvrira pas.
 */
app.get('/api/auth/habitants', async () => {
  if (!LISTER_HABITANTS) return { habitants: [] };
  return {
    habitants: db
      .comptes()
      .filter((c) => c.actif)
      .map((c) => ({
        // L'`id` et pas l'`identifiant` : on ne livre pas la chaîne qu'on
        // tape pour se connecter. Le choix se fait sur un visage.
        id: c.id,
        nom: c.nom,
        initiale: [...c.nom.trim()][0]?.toUpperCase() ?? '?',
        role: c.role,
      })),
  };
});

/** Ouvre une session, pose le cookie, et rend le compte. Partagé par les deux entrées. */
async function ouvrirLaSession(
  compte: Compte,
  req: FastifyRequest,
  reply: FastifyReply,
  rester = true,
) {
  const jeton = nouveauJeton();
  db.ouvrirSession({
    id: nouvelId('s'),
    compteId: compte.id,
    empreinte: empreinteJeton(jeton),
    appareil: nommerAppareil(req.headers['user-agent']),
    dureeJours: SESSION_JOURS,
  });
  db.marquerConnexion(compte.id);

  // `x-forwarded-proto` : derrière un tunnel qui termine le HTTPS, la requête
  // arrive en clair sur le serveur alors que le navigateur, lui, est bien en
  // HTTPS. Sans cette lecture, le cookie manquerait son attribut `Secure`.
  const securise = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

  // « Rester connecte » decoche : cookie de SESSION, qui meurt a la fermeture
  // du navigateur. C'est ce qu'on veut sur la tablette d'une chambre d'amis
  // ou sur un ordinateur emprunte. La session reste valable cote serveur, mais
  // le navigateur ne la rapporte plus.
  reply.header('Set-Cookie', poserCookie(jeton, securise, rester));
  // Le jeton est rendu AUSSI dans le corps, pour l'application iOS, qui n'a pas
  // de magasin à cookies aussi commode qu'un navigateur.
  return { compte: db.compte(compte.id), jeton };
}

/**
 * Le tout premier compte.
 *
 * Ouvert uniquement tant qu'aucun compte n'existe : ensuite la route refuse,
 * sinon n'importe qui se fabriquerait un administrateur. C'est le seul moment
 * où un compte se crée sans être déjà connecté.
 */
app.post<{ Body: { identifiant?: string; nom?: string; motDePasse?: string } }>(
  '/api/auth/premier-compte',
  async (req, reply) => {
    if (db.nbComptes() > 0)
      return reply.status(409).send({ error: 'La maison a déjà un administrateur.' });

    const identifiant = normaliserIdentifiant(req.body?.identifiant ?? '');
    const nom = (req.body?.nom ?? '').trim();
    const motDePasse = req.body?.motDePasse ?? '';

    const refus =
      validerIdentifiant(identifiant) ?? validerNom(nom) ?? validerMotDePasse(motDePasse, identifiant);
    if (refus) return reply.status(400).send({ error: refus });

    const compte = db.creerCompte({
      id: nouvelId('u'),
      identifiant,
      nom,
      role: 'admin',
      hash: await hacher(motDePasse),
    });

    console.log(`[comptes] premier compte créé : ${compte.identifiant} (administrateur)`);
    return ouvrirLaSession(compte, req, reply);
  },
);

app.post<{
  Body: { identifiant?: string; compteId?: string; motDePasse?: string; rester?: boolean };
}>('/api/auth/login', async (req, reply) => {
  // Deux entrees : on tape son identifiant, ou on choisit son visage dans la
  // liste des habitants. La seconde renvoie un `compteId`, jamais
  // l'identifiant de connexion.
  const choisi = req.body?.compteId ? db.compte(req.body.compteId) : null;
  const identifiant = choisi
    ? choisi.identifiant
    : normaliserIdentifiant(req.body?.identifiant ?? '');
  const motDePasse = req.body?.motDePasse ?? '';
  const rester = req.body?.rester !== false;
  const cles = [`id:${identifiant}`, `ip:${req.ip}`];

    const attente = guichet.attente(cles);
    if (attente)
      return reply
        .status(429)
        .send({ error: `Trop d'essais. Réessayez dans ${attente} minute${attente > 1 ? 's' : ''}.` });

    const trouve = identifiant ? db.identification(identifiant) : null;

    // On vérifie le mot de passe MÊME si le compte n'existe pas, contre un
    // hachage jetable : sans ça, un identifiant inconnu répondrait en une
    // milliseconde et un identifiant connu en plusieurs dizaines, ce qui
    // révélerait quels comptes existent dans la maison.
    const ok = trouve
      ? await verifier(motDePasse, trouve.hash)
      : (await verifier(motDePasse, HACHAGE_LEURRE), false);

    if (!ok || !trouve?.compte.actif) {
      guichet.echec(cles);
      return reply.status(401).send({ error: REFUS_CONNEXION });
    }

    guichet.succes(cles);
    return ouvrirLaSession(trouve.compte, req, reply, rester);
  },
);

app.post('/api/auth/logout', async (req, reply) => {
  if (req.sessionId) db.fermerSession(req.sessionId, req.compte?.id);
  reply.header('Set-Cookie', retirerCookie());
  return { ok: true };
});

app.get('/api/auth/sessions', async (req) => {
  const compte = req.compte!;
  return {
    sessions: db.sessionsDe(compte.id).map((s) => ({ ...s, courante: s.id === req.sessionId })),
  };
});

app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
  db.fermerSession(req.params.id, req.compte!.id);
  return { ok: true };
});

/**
 * Fermer TOUTES ses sessions sauf celle d'ou part la demande.
 *
 * Le geste qu'on cherche quand on a un doute : reprendre la main partout
 * ailleurs sans se deconnecter de l'appareil qu'on a sous les yeux.
 */
app.delete('/api/auth/sessions', async (req) => {
  const compte = req.compte!;
  const autres = db.sessionsDe(compte.id).filter((s) => s.id !== req.sessionId);
  for (const s of autres) db.fermerSession(s.id, compte.id);
  return { fermees: autres.length };
});

/** Changer SON mot de passe : il faut l'ancien, même déjà connecté. */
app.post<{ Body: { ancien?: string; nouveau?: string } }>(
  '/api/auth/mot-de-passe',
  async (req, reply) => {
    const compte = req.compte!;
    const identification = db.identification(compte.identifiant);
    if (!identification || !(await verifier(req.body?.ancien ?? '', identification.hash)))
      return reply.status(401).send({ error: 'Mot de passe actuel incorrect.' });

    const nouveau = req.body?.nouveau ?? '';
    const refus = validerMotDePasse(nouveau, compte.identifiant);
    if (refus) return reply.status(400).send({ error: refus });

    db.changerMotDePasse(compte.id, await hacher(nouveau));
    // Toutes les autres sessions tombent : changer son mot de passe sert
    // précisément à reprendre la main sur un appareil qu'on ne contrôle plus.
    db.fermerSessionsDe(compte.id);
    return ouvrirLaSession(compte, req, reply);
  },
);

// ----------------------------------------------------- la gestion des comptes

app.get('/api/comptes', async (req, reply) => {
  if (!exige(req, reply, 'admin')) return reply;
  return { comptes: db.comptes() };
});

app.post<{ Body: { identifiant?: string; nom?: string; motDePasse?: string; role?: Role } }>(
  '/api/comptes',
  async (req, reply) => {
    if (!exige(req, reply, 'admin')) return reply;

    const identifiant = normaliserIdentifiant(req.body?.identifiant ?? '');
    const nom = (req.body?.nom ?? '').trim();
    const motDePasse = req.body?.motDePasse ?? '';
    const role = req.body?.role ?? 'habitant';

    const refus =
      validerIdentifiant(identifiant) ??
      validerNom(nom) ??
      validerMotDePasse(motDePasse, identifiant) ??
      (ROLES.includes(role) ? null : 'Rôle inconnu.');
    if (refus) return reply.status(400).send({ error: refus });

    if (db.identification(identifiant))
      return reply.status(409).send({ error: 'Cet identifiant est déjà pris.' });

    return {
      compte: db.creerCompte({
        id: nouvelId('u'),
        identifiant,
        nom,
        role,
        hash: await hacher(motDePasse),
      }),
    };
  },
);

app.patch<{ Params: { id: string }; Body: { nom?: string; role?: Role; actif?: boolean } }>(
  '/api/comptes/:id',
  async (req, reply) => {
    if (!exige(req, reply, 'admin')) return reply;

    const cible = db.compte(req.params.id);
    if (!cible) return reply.status(404).send({ error: 'Compte introuvable.' });

    // On ne se retire pas à soi-même ses propres droits : c'est la façon la
    // plus courante de se retrouver enfermé dehors de sa propre maison.
    if (cible.id === req.compte!.id && (req.body.role !== undefined || req.body.actif === false))
      return reply
        .status(400)
        .send({ error: 'Vous ne pouvez pas modifier vos propres droits.' });

    const perdAdmin =
      cible.role === 'admin' && (req.body.role !== undefined || req.body.actif === false);
    if (perdAdmin && db.nbAdmins() <= 1)
      return reply.status(400).send({ error: 'Il doit rester au moins un administrateur actif.' });

    if (req.body.nom !== undefined) {
      const refus = validerNom(req.body.nom);
      if (refus) return reply.status(400).send({ error: refus });
    }
    if (req.body.role !== undefined && !ROLES.includes(req.body.role))
      return reply.status(400).send({ error: 'Rôle inconnu.' });

    const modifie = db.modifierCompte(cible.id, req.body);
    // Un compte désactivé ou rétrogradé ne doit pas garder ses sessions.
    if (req.body.actif === false || req.body.role !== undefined) db.fermerSessionsDe(cible.id);
    return { compte: modifie };
  },
);

/** Réinitialiser le mot de passe de quelqu'un d'autre, sans connaître l'ancien. */
app.post<{ Params: { id: string }; Body: { motDePasse?: string } }>(
  '/api/comptes/:id/mot-de-passe',
  async (req, reply) => {
    if (!exige(req, reply, 'admin')) return reply;

    const cible = db.compte(req.params.id);
    if (!cible) return reply.status(404).send({ error: 'Compte introuvable.' });

    const refus = validerMotDePasse(req.body?.motDePasse ?? '', cible.identifiant);
    if (refus) return reply.status(400).send({ error: refus });

    db.changerMotDePasse(cible.id, await hacher(req.body!.motDePasse!));
    db.fermerSessionsDe(cible.id);
    return { ok: true };
  },
);

app.delete<{ Params: { id: string } }>('/api/comptes/:id', async (req, reply) => {
  if (!exige(req, reply, 'admin')) return reply;

  const cible = db.compte(req.params.id);
  if (!cible) return reply.status(404).send({ error: 'Compte introuvable.' });
  if (cible.id === req.compte!.id)
    return reply.status(400).send({ error: 'On ne supprime pas son propre compte.' });
  if (cible.role === 'admin' && db.nbAdmins() <= 1)
    return reply.status(400).send({ error: 'Il doit rester au moins un administrateur actif.' });

  db.supprimerCompte(cible.id);
  return { ok: true };
});

// ------------------------------------------------------------------ diffusion

const sockets = new Set<{ send(data: string): void }>();

app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({
    type: 'snapshot', states: hub.snapshot(), connections: hub.connections(),
  }));
  socket.on('close', () => sockets.delete(socket));
});

hub.on('state', (state) => {
  broadcast({ type: 'state', state });
  // Le pont reçoit exactement ce que reçoit l'interface web : l'état confirmé
  // par le matériel, jamais l'intention du clic.
  pont.pousser(state);
});
hub.on('reload', () =>
  broadcast({ type: 'reload', states: hub.snapshot(), connections: hub.connections() }),
);

// La santé des canaux change sans qu'aucun état d'équipement ne bouge :
// un broker qui tombe doit se voir tout de suite dans l'interface.
const veilleCanaux = setInterval(() => broadcast({ type: 'connections', connections: hub.connections() }), 5_000);
veilleCanaux.unref();

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const s of sockets) {
    try {
      s.send(payload);
    } catch {
      // Un client parti sans dire au revoir ne doit pas bloquer les autres.
      sockets.delete(s);
    }
  }
}

// ----------------------------------------------------------------------- état

app.get('/api/state', async () => ({
  connections: hub.connections(),
  states: hub.snapshot(),
}));

app.post<{ Params: { id: string }; Body: Command }>(
  '/api/devices/:id/command',
  async (req, reply) => {
    if (!peutPiloter(req.compte!, req.params.id))
      return reply.status(403).send({ ok: false, error: 'Un invité ne pilote que la lumière et les volets.' });
    try {
      await hub.command(req.params.id, req.body, 'ui');
      return { ok: true, state: hub.get(req.params.id) };
    } catch (err) {
      return reply.status(400).send({ ok: false, error: (err as Error).message });
    }
  },
);

/** Action groupée : toutes les lumières d'une zone, tous les volets, etc. */
app.post<{ Body: { deviceIds: string[]; command: Command } }>(
  '/api/commands/bulk',
  async (req, reply) => {
    const { deviceIds, command } = req.body;
    if (!Array.isArray(deviceIds)) return reply.status(400).send({ ok: false, error: 'deviceIds requis' });
    if (!deviceIds.every((id) => typeof id === 'string' && peutPiloter(req.compte!, id)))
      return reply.status(403).send({ ok: false, error: 'Un invité ne pilote que la lumière et les volets.' });

    const results = await Promise.allSettled(
      deviceIds.map((id) => hub.command(id, command, 'ui')),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    return { ok: failed === 0, total: deviceIds.length, failed };
  },
);

app.get<{ Querystring: { device?: string; hours?: string } }>('/api/history', async (req, reply) => {
  const { device, hours } = req.query;
  if (!device) return reply.status(400).send({ error: 'paramètre device requis' });
  const since = Date.now() - Number(hours ?? 24) * 3_600_000;
  return { device, points: db.history(device, since) };
});

app.get('/api/journal', async () => ({ entries: db.recentActions(120) }));

// ---------------------------------------------------------------- scènes

/**
 * Applique une scène.
 *
 * Les commandes partent en parallèle mais on attend TOUTES les réponses : une
 * scène qui rend la main avant d'avoir fini laisserait l'interface annoncer
 * « bonne nuit » alors que la moitié des volets n'a pas bougé.
 */
app.post<{ Params: { id: string } }>('/api/scenes/:id/apply', async (req, reply) => {
  // Une scène touche au chauffage et à toute la maison : pas pour un invité.
  if (!exige(req, reply, 'habitant')) return reply;
  if (!config!.scenes?.some((s) => s.id === req.params.id))
    return reply.status(404).send({ ok: false, error: 'Scène inconnue.' });
  // Jouée à la main, mais par le même chemin qu'un départ programmé : elle
  // hérite ainsi des conditions, des retards et du journal. Deux chemins
  // d'exécution finiraient par diverger.
  return planificateur.jouer(req.params.id, 'ui');
});

/** Les départs passés, et pourquoi certains n'ont pas eu lieu. */
app.get<{ Querystring: { limit?: string } }>('/api/scenes/history', async (req) => ({
  runs: planificateur.historique(Math.min(200, Number(req.query.limit) || 40)),
}));

/** Le prochain départ programmé : ce que l'interface annonce en tête. */
app.get('/api/scenes/next', async () => ({ next: planificateur.prochaine() }));

app.get('/api/scenes', async () => ({ scenes: config!.scenes ?? [] }));

app.put<{ Body: SceneConfig[] }>('/api/scenes', async (req, reply) =>
  applyConfig({ ...config!, scenes: req.body }, reply),
);

/**
 * Remet les scènes livrées, sans toucher au reste.
 * Utile quand les valeurs par défaut s'améliorent : on récupère les nouvelles
 * sans perdre ses zones, ses équipements ni ses raccordements.
 */
app.post('/api/scenes/reset', async (_req, reply) =>
  applyConfig({ ...config!, scenes: buildSeedConfig().scenes }, reply),
);

// ----------------------------------------------------------- connectivité

/** Les canaux et leur santé. */
app.get('/api/connections', async () => ({ connections: hub.connections() }));

app.post<{ Body: Connection }>('/api/connections', async (req, reply) => {
  const connections = [...config!.connections, req.body];
  return applyConfig({ ...config!, connections }, reply);
});

app.put<{ Params: { id: string }; Body: Connection }>(
  '/api/connections/:id',
  async (req, reply) => {
    const connections = config!.connections.map((c) => (c.id === req.params.id ? req.body : c));
    return applyConfig({ ...config!, connections }, reply);
  },
);

app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
  if (req.params.id === 'sim')
    return reply.status(400).send({ ok: false, error: 'Le simulateur ne peut pas être supprimé.' });

  const connections = config!.connections.filter((c) => c.id !== req.params.id);
  // Les équipements qui pointaient dessus retombent en simulé plutôt que de
  // devenir des orphelins que la validation refuserait ensuite.
  const devices = config!.devices.map((d) =>
    d.binding?.connectionId === req.params.id ? { ...d, binding: null } : d,
  );
  return applyConfig({ ...config!, connections, devices }, reply);
});

/**
 * Essai à blanc d'une connexion, avant de l'enregistrer.
 * Rien n'est écrit en base : on ouvre, on regarde, on referme.
 */
app.post<{ Body: Connection }>('/api/connections/test', async (req, reply) => {
  const c = req.body;
  const debut = Date.now();
  try {
    const adapter = fabriquerPourTest(c);
    if (!adapter) return reply.status(400).send({ ok: false, error: 'Type de connexion inconnu.' });
    try {
      await adapter.start();
    } finally {
      // Même si l'ouverture a échoué : un client MQTT qui n'a pas trouvé son
      // broker continue d'essayer toutes les cinq secondes tant qu'on ne
      // l'arrête pas, et chaque clic sur « Tester » en laissait un de plus.
      await adapter.stop().catch(() => undefined);
    }
    return { ok: true, ms: Date.now() - debut };
  } catch (e) {
    return reply.status(200).send({ ok: false, error: (e as Error).message, ms: Date.now() - debut });
  }
});

/** Ce que les canaux ont entendu sans savoir à qui l'attribuer. */
app.get('/api/discovery', async () => ({ candidates: hub.candidates() }));

app.delete<{ Querystring: { connection?: string } }>('/api/discovery', async (req) => {
  hub.clearCandidates(req.query.connection);
  return { ok: true };
});

/** L'état du pont HomeKit, et ce qu'il n'a pas pu exposer. */
app.get('/api/homekit', async () => pont.etat(config!));

/**
 * La consommation de la maison.
 *
 * Tout est calculé à la demande depuis les mesures brutes : rien n'est
 * pré-agrégé. À un point par seconde et par équipement, un mois tient en
 * quelques milliers de lignes, et un agrégat figé serait faux dès qu'on
 * corrige une mesure ou qu'on change de compteur.
 *
 * Ce que cette route NE rend PAS, volontairement : la répartition par usage et
 * le classement des appareils. Un compteur général ne sait pas dire quelle
 * part revient au chauffage : il faudrait une mesure par circuit. La déduire
 * serait l'inventer.
 */
app.get<{ Querystring: { period?: string } }>('/api/energy', async (req) => {
  const demande = req.query.period ?? 'jour';
  const periode = (['jour', 'semaine', 'mois'].includes(demande) ? demande : 'jour') as Periode;
  const fuseau = config!.house.timezone;
  const compteurId = config!.energy?.meterDeviceId ?? '';
  const compteur = config!.devices.find((d) => d.id === compteurId);

  if (!compteur) {
    return {
      period: periode,
      meter: null,
      message: 'Aucun compteur désigné. Choisis-en un dans Paramétrage, onglet Maison.',
    };
  }

  const maintenant = Date.now();
  const bornes = bornesPeriode(periode, new Date(maintenant), fuseau);
  // Une seule requête couvre la période ET la précédente : deux allers-retours
  // en base pour un écart de pourcentage n'en valent pas la peine.
  const lectures = db.readings(compteurId, bornes.precedentDebut, bornes.fin);

  const courant = integrer(lectures, bornes.debut, bornes.fin);
  const precedent = integrer(lectures, bornes.precedentDebut, bornes.precedentFin);
  const seaux = repartir(lectures, periode, bornes, fuseau, maintenant);
  const sommet = pic(seaux);

  const prix = config!.energy?.pricePerKwh ?? 0;
  const ecoule = Math.max(1, Math.min(maintenant, bornes.fin) - bornes.debut);

  return {
    period: periode,
    titre: bornes.titre,
    comparaison: bornes.comparaison,
    meter: {
      id: compteur.id,
      label: compteur.label,
      // La puissance de l'instant, qui n'est pas dans l'historique.
      watts: hub.get(compteur.id)?.caps.find((c) => c.kind === 'sensor')?.value ?? null,
      joignable: hub.get(compteur.id)?.health === 'online',
    },
    kwh: Number(courant.kwh.toFixed(2)),
    precedent: Number(precedent.kwh.toFixed(2)),
    cout: prix > 0 ? Number((courant.kwh * prix).toFixed(2)) : null,
    prixKwh: prix,
    pic: sommet ? { kwh: Number(sommet.kwh.toFixed(2)), label: sommet.label } : null,
    seaux: seaux.map((s) => ({ label: s.label, kwh: Number(s.kwh.toFixed(3)), futur: s.futur })),
    /**
     * La part de la période réellement mesurée. Un serveur arrêté laisse un
     * trou : mieux vaut annoncer « 60 % mesurés » qu'un total qui paraît
     * complet et ne l'est pas.
     */
    couverture: Math.min(1, Number((courant.mesureMs / ecoule).toFixed(3))),
  };
});

// ------------------------------------------------------------------ caméras

/**
 * Les caméras déclarées, sans leurs secrets.
 *
 * Ni mot de passe ni adresse : l'interface n'en a pas besoin puisqu'elle
 * demande l'image au serveur, et une adresse de caméra révèle la topologie du
 * réseau autant que le nom d'utilisateur.
 */
app.get('/api/cameras', async () => ({
  cameras: (config!.cameras ?? []).slice().sort((a, b) => a.order - b.order).map(publique),
}));

/**
 * L'image d'une caméra, relayée.
 *
 * `no-store` est délibéré : une image de caméra n'a aucune raison de rester
 * dans le cache d'un navigateur, ni sur le disque d'un téléphone prêté.
 */
app.get<{ Params: { id: string } }>('/api/cameras/:id/snapshot', async (req, reply) => {
  const camera = (config!.cameras ?? []).find((c) => c.id === req.params.id);
  if (!camera) return reply.status(404).send({ ok: false, error: 'Caméra inconnue.' });

  try {
    const image = await instantane(camera);
    return reply
      .header('cache-control', 'no-store, private')
      .header('x-temps-ms', String(image.ms))
      .type(image.type)
      .send(image.corps);
  } catch (e) {
    return reply.status(502).send({ ok: false, error: (e as Error).message });
  }
});

/** Essai à blanc, avant d'enregistrer, comme pour les canaux. */
app.post<{ Body: CameraConfig }>('/api/cameras/test', async (req, reply) => {
  const debut = Date.now();
  try {
    // On force l'essai même sur une caméra au repos : c'est justement le
    // moment où on veut vérifier avant de l'allumer.
    const image = await instantane({ ...req.body, enabled: true });
    return {
      ok: true,
      ms: Date.now() - debut,
      type: image.type,
      octets: image.corps.length,
    };
  } catch (e) {
    return reply.status(200).send({ ok: false, error: (e as Error).message, ms: Date.now() - debut });
  }
});

/** Les raccordements tout faits proposés par l'interface. */
app.get('/api/presets', async () => ({ presets: PRESETS }));

// -------------------------------------------------------------- paramétrage

/**
 * La configuration, à la mesure du compte qui la demande.
 *
 * Un administrateur la reçoit entière : c'est lui qui édite les
 * raccordements. Tout autre compte reçoit la même maison SANS ses secrets :
 * mot de passe du broker, jeton Home Assistant, adresses et identifiants des
 * caméras. L'interface n'en a pas besoin pour piloter, et un habitant qui
 * connaît le mot de passe du broker peut parler aux modules sans passer par
 * le serveur, donc sans journal.
 */
app.get('/api/config', async (req) =>
  auMoins(req.compte!.role, 'admin') ? config : expurgee(config!),
);

function expurgee(cfg: HouseConfig): HouseConfig {
  return {
    ...cfg,
    connections: cfg.connections.map((c) => ({
      ...c,
      settings: { ...c.settings, password: undefined, token: undefined, headers: undefined },
    })),
    cameras: (cfg.cameras ?? []).map((c) => ({ ...c, snapshotUrl: '', username: '', password: '' })),
  };
}

app.put<{ Body: HouseConfig }>('/api/config', async (req, reply) => {
  return applyConfig(req.body, reply);
});

/** Réglages seuls : évite de renvoyer toute la maison pour changer une consigne. */
app.patch<{ Body: Partial<HouseConfig> }>('/api/config/settings', async (req, reply) => {
  const { zones: _z, devices: _d, ...rest } = req.body;
  return applyConfig({ ...config!, ...rest }, reply);
});

app.post<{ Body: ZoneConfig }>('/api/config/zones', async (req, reply) => {
  const zones = [...config!.zones, req.body];
  return applyConfig({ ...config!, zones }, reply);
});

app.put<{ Params: { id: string }; Body: ZoneConfig }>(
  '/api/config/zones/:id',
  async (req, reply) => {
    const zones = config!.zones.map((z) => (z.id === req.params.id ? req.body : z));
    return applyConfig({ ...config!, zones }, reply);
  },
);

app.delete<{ Params: { id: string } }>('/api/config/zones/:id', async (req, reply) => {
  const zones = config!.zones.filter((z) => z.id !== req.params.id);
  // Supprimer une zone sans ses équipements laisserait des orphelins que la
  // validation refuserait ensuite. On nettoie dans le même mouvement.
  const devices = config!.devices.filter((d) => d.zoneId !== req.params.id);
  return applyConfig({ ...config!, zones, devices }, reply);
});

app.post<{ Body: DeviceConfig }>('/api/config/devices', async (req, reply) => {
  const devices = [...config!.devices, req.body];
  return applyConfig({ ...config!, devices }, reply);
});

app.put<{ Params: { id: string }; Body: DeviceConfig }>(
  '/api/config/devices/:id',
  async (req, reply) => {
    const devices = config!.devices.map((d) => (d.id === req.params.id ? req.body : d));
    return applyConfig({ ...config!, devices }, reply);
  },
);

app.delete<{ Params: { id: string } }>('/api/config/devices/:id', async (req, reply) => {
  const devices = config!.devices.filter((d) => d.id !== req.params.id);
  return applyConfig({ ...config!, devices }, reply);
});

/** Remet la maison de référence : utile quand on a tout cassé en explorant. */
app.post('/api/config/reset', async (_req, reply) => {
  return applyConfig(buildSeedConfig(), reply);
});

/** Instancie un canal jetable, juste pour vérifier qu'il répond. */
function fabriquerPourTest(c: Connection): Adapter | null {
  const ctx = { connection: c, emit: () => {}, warn: () => {} };
  if (c.kind === 'mqtt') return new MqttAdapter(ctx);
  if (c.kind === 'http') return new HttpAdapter(ctx);
  if (c.kind === 'modbus') return new ModbusAdapter(ctx);
  if (c.kind === 'homeassistant') return new HomeAssistantAdapter(ctx);
  return null;
}

/**
 * Applique une configuration.
 *
 * L'ordre compte : on l'APPLIQUE d'abord (canaux, planificateur), et on ne
 * l'ÉCRIT en base que si tout a tenu. Écrire avant d'appliquer, c'est risquer
 * une configuration que le serveur accepte en base mais refuse au démarrage :
 * il ne redémarrerait plus jamais, et systemd le relancerait en boucle.
 *
 * Deux filets avant même d'essayer : la forme (un champ absent, un type
 * faux, un fuseau inconnu) puis la cohérence métier. Les deux rendent des
 * messages lisibles plutôt qu'une trace de pile.
 *
 * Les applications sont sérialisées : deux enregistrements rapprochés : un
 * double clic sur « Enregistrer » : s'enchaînent au lieu de se chevaucher.
 */
let applicationEnCours: Promise<unknown> = Promise.resolve();

async function applyConfig(next: HouseConfig, reply: { status(c: number): { send(b: unknown): unknown } }) {
  const forme = verifierForme(next);
  if (forme) return reply.status(400).send({ ok: false, error: forme });

  const issues = validateConfig(next);
  const blocking = issues.filter(isBlocking);
  if (blocking.length) return reply.status(400).send({ ok: false, issues: blocking });

  const tour = applicationEnCours.then(() => appliquer(next));
  applicationEnCours = tour.catch(() => undefined);
  try {
    await tour;
  } catch (e) {
    return reply.status(500).send({ ok: false, error: (e as Error).message });
  }
  return { ok: true, config: next, warnings: issues.filter((i) => !isBlocking(i)) };
}

async function appliquer(next: HouseConfig): Promise<void> {
  const precedente = config!;
  const avant = precedente.homekit;
  config = next;
  try {
    await hub.reload(next);
    // Les horaires changent avec la configuration : un réveil déplacé doit
    // partir à sa nouvelle heure sans redémarrer le serveur.
    planificateur.reload(next);
  } catch (e) {
    // Retour à la configuration d'avant, qui, elle, tenait.
    config = precedente;
    console.warn(`[config] refusée à l'application, retour en arrière : ${(e as Error).message}`);
    try {
      await hub.reload(precedente);
      planificateur.reload(precedente);
    } catch (e2) {
      console.error(`[config] le retour en arrière a échoué : ${(e2 as Error).message}`);
    }
    throw new Error(`Configuration refusée : ${(e as Error).message}`);
  }
  db.saveConfig(next);
  if (configDeSecours) {
    configDeSecours = false;
    console.log('[config] configuration enregistrée : la maison de secours est remplacée.');
  }

  // Le pont ne se relance que si quelque chose le concerne a bougé : republier
  // à chaque enregistrement ferait clignoter la maison dans l'app d'Apple.
  if (pontAChange(avant, next.homekit) || listeAChange(next)) {
    try {
      await pont.start(next);
    } catch (e) {
      console.warn(`[homekit] ${(e as Error).message}`);
    }
  }
}

/** Les réglages du pont ont-ils bougé ? */
function pontAChange(avant: HouseConfig['homekit'], apres: HouseConfig['homekit']): boolean {
  return JSON.stringify(avant ?? null) !== JSON.stringify(apres ?? null);
}

/**
 * La liste des accessoires a-t-elle bougé ?
 *
 * Un équipement ajouté ou renommé doit apparaître dans l'app Maison, mais un
 * simple changement de raccordement ne justifie pas de republier le pont.
 */
let signatureAccessoires = '';
function listeAChange(cfg: HouseConfig): boolean {
  const signature = cfg.devices.map((d) => `${d.id}:${d.type}:${d.metric ?? ''}:${d.label}`).join('|');
  if (signature === signatureAccessoires) return false;
  signatureAccessoires = signature;
  return true;
}
listeAChange(config);

// ------------------------------------------------------------- annonce réseau

/**
 * La maison s'annonce sur le réseau local.
 *
 * Coder une adresse IP en dur dans une app mobile est le premier piège : elle
 * change au premier redémarrage de la box. Ici le serveur se présente, et le
 * téléphone le trouve : y compris à travers le tunnel, qui place le téléphone
 * sur le même réseau.
 */
let annonce: { stop: () => void } | null = null;
try {
  // Sur Linux, avahi-daemon tourne déjà et occupe le port mDNS. Si on lui
  // confie l'annonce (deploiement/ruche-avahi.service), il faut faire taire
  // celle-ci : deux répondeurs pour le même service peuvent se contredire.
  if (process.env.BONJOUR === 'off') throw new Error('annonce désactivée (BONJOUR=off)');

  const { Bonjour } = await import('bonjour-service');
  const bonjour = new Bonjour();
  // Le nom du service et le nom d'hôte sont deux choses différentes : on
  // publie explicitement l'hôte joignable, sinon le client chercherait un
  // « maison.local » qui n'existe pas.
  // `os.hostname()` rend le nom DNS complet (« macbook-pro.home ») ; le nom
  // mDNS est le premier segment suivi de `.local`.
  const { hostname } = await import('node:os');
  const hote = `${hostname().split('.')[0]}.local`;

  const service = bonjour.publish({
    name: 'maison',
    type: 'domotique',
    protocol: 'tcp',
    port: PORT,
    txt: { version: '1', host: hote, port: String(PORT), devices: String(config.devices.length) },
  });
  annonce = { stop: () => { service.stop?.(); bonjour.destroy(); } };
  console.log(`[réseau] annoncé en Bonjour : ${hote}:${PORT}`);
} catch (err) {
  // Pas d'annonce possible (conteneur, réseau restreint) : ce n'est pas une
  // raison pour refuser de démarrer. L'app pourra saisir l'adresse à la main.
  console.warn(`[réseau] annonce Bonjour indisponible : ${(err as Error).message}`);
}

// ---------------------------------------------------------------- entretien

const pruner = setInterval(() => {
  db.prune().catch((e: Error) => console.warn(`[base] purge interrompue : ${e.message}`));
}, 12 * 3_600_000);
pruner.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      annonce?.stop();
      planificateur.stop();
      await pont.stop();
      await hub.stop();
      await app.close();
      db.close();
      process.exit(0);
    })();
  });
}

// ------------------------------------------------------------- l'interface
//
// Le serveur sert lui-même l'application compilée. Sans ça l'interface
// dépendrait du serveur de développement Vite, donc d'un Mac allumé, alors que
// tout l'intérêt est qu'elle vive sur la même machine que le cerveau : on
// ouvre http://<la-maison>:3001 depuis n'importe quel téléphone du réseau, et
// c'est cette adresse qu'on ajoute à l'écran d'accueil.
//
// `dist/` n'existe pas tant qu'on n'a pas compilé. On le dit et on continue :
// en développement, Vite sert l'interface sur son propre port.
const WEB = process.env.WEB_DIR ?? fileURLToPath(new URL('../../app/dist/', import.meta.url));

if (existsSync(join(WEB, 'index.html'))) {
  await app.register(fastifyStatic, { root: WEB, prefix: '/', index: ['index.html'] });

  // L'interface a ses propres routes côté navigateur (/energie, /zone/z03…).
  // Rouvrir l'application sur l'une d'elles doit renvoyer la coquille et non
  // un 404, sinon le raccourci de l'écran d'accueil ouvre une page blanche.
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.status(404).send({ error: 'Route inconnue.' });
    }
    return reply.sendFile('index.html');
  });

  console.log(`[web] interface servie depuis ${WEB}`);
} else {
  console.log(`[web] aucune interface compilée : « npm run build -w @domo/app » pour la servir ici`);
}

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`[http] http://localhost:${PORT}  ·  base ${DB_FILE}`);
} catch (err) {
  // Une trace de pile de vingt lignes pour un port occupé n'aide personne :
  // on dit ce qui se passe et ce qu'il faut faire.
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `\n[http] Le port ${PORT} est déjà utilisé : un autre serveur tourne probablement.\n` +
        `       Pour voir lequel :  lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
        `       Pour le libérer  :  npm run libere-ports\n` +
        `       Ou changer de port :  PORT=3002 npm run dev\n`,
    );
    annonce?.stop();
    planificateur.stop();
    await pont.stop();
    await hub.stop();
    db.close();
    process.exit(1);
  }
  throw err;
}
