import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  buildSeedConfig,
  isBlocking,
  migrateConfig,
  validateConfig,
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
import type { Adapter } from './adapters/adapter.js';
import { PontHomeKit } from './homekit.js';
import { Planificateur } from './planificateur.js';
import { instantane, publique } from './cameras.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_FILE = process.env.DB_FILE ?? new URL('../../../data/domotique.db', import.meta.url).pathname;

const db = new Db(DB_FILE);

// Premier démarrage : on sème la maison lue sur le plan, pour que
// l'application ne s'ouvre jamais sur un écran vide.
let config = db.loadConfig();
if (!config) {
  config = buildSeedConfig();
  db.saveConfig(config);
  console.log('[config] première initialisation — maison de référence chargée');
} else {
  // Les bases écrites avant le bus d'adaptateurs sont converties au vol.
  const migre = migrateConfig(config);
  if (migre !== config) {
    config = migre;
    db.saveConfig(config);
    console.log('[config] migrée vers les connexions multiples');
  }
}

const hub = new StateHub(config, db);
hub.on('warn', (m: string) => console.warn(`[canal] ${m}`));

await hub.start();
for (const c of hub.connections()) {
  const marque = c.state === 'connected' ? '✓' : c.state === 'disabled' ? '·' : '✗';
  console.log(`[canal] ${marque} ${c.label} — ${c.devices} équipements${c.detail ? ` (${c.detail})` : ''}`);
}

/**
 * Le planificateur : ce qui fait partir une scène toute seule.
 *
 * Il démarre avec le serveur et ne rattrape jamais un départ manqué — un
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
        ? ` — prochaine : ${suivante.label} à ${new Date(suivante.at).toLocaleString('fr-FR', { timeZone: config.house.timezone })}`
        : ''),
  );
}

/**
 * Le pont HomeKit. Éteint tant que la configuration ne l'allume pas — publier
 * la maison sur le réseau n'est pas une décision à prendre pour quelqu'un.
 */
const pont = new PontHomeKit(hub, new URL('../../../data/homekit', import.meta.url).pathname);
try {
  await pont.start(config);
  if (config.homekit?.enabled) {
    const e = pont.etat(config);
    console.log(`[homekit] ✓ pont ouvert — ${e.exposes} accessoires` +
      (e.skipped.length ? `, ${e.skipped.length} écarté(s)` : ''));
  }
} catch (e) {
  // Un pont qui refuse de s'ouvrir ne doit pas empêcher la maison de marcher.
  console.warn(`[homekit] ${(e as Error).message}`);
}

const app = Fastify({ logger: false });
await app.register(websocket);

// L'interface tourne sur un autre port en développement.
app.addHook('onSend', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'content-type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
});
app.options('/*', async (_req, reply) => reply.status(204).send());

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
  return { device, points: db.history(device, since).reverse() };
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

/** Le prochain départ programmé — ce que l'interface annonce en tête. */
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
    await adapter.start();
    await adapter.stop();
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
 * part revient au chauffage — il faudrait une mesure par circuit. La déduire
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

/** Essai à blanc, avant d'enregistrer — comme pour les canaux. */
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

app.get('/api/config', async () => config);

app.put<{ Body: HouseConfig }>('/api/config', async (req, reply) => {
  return applyConfig(req.body, reply);
});

/** Réglages seuls — évite de renvoyer toute la maison pour changer une consigne. */
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

/** Remet la maison de référence — utile quand on a tout cassé en explorant. */
app.post('/api/config/reset', async (_req, reply) => {
  return applyConfig(buildSeedConfig(), reply);
});

/** Instancie un canal jetable, juste pour vérifier qu'il répond. */
function fabriquerPourTest(c: Connection): Adapter | null {
  const ctx = { connection: c, emit: () => {}, warn: () => {} };
  if (c.kind === 'mqtt') return new MqttAdapter(ctx);
  if (c.kind === 'http') return new HttpAdapter(ctx);
  if (c.kind === 'modbus') return new ModbusAdapter(ctx);
  return null;
}

async function applyConfig(next: HouseConfig, reply: { status(c: number): { send(b: unknown): unknown } }) {
  const issues = validateConfig(next);
  const blocking = issues.filter(isBlocking);
  if (blocking.length) return reply.status(400).send({ ok: false, issues: blocking });

  const avant = config!.homekit;
  config = next;
  db.saveConfig(next);
  await hub.reload(next);

  // Les horaires changent avec la configuration : un réveil déplacé doit
  // partir à sa nouvelle heure sans redémarrer le serveur.
  planificateur.reload(next);

  // Le pont ne se relance que si quelque chose le concerne a bougé : republier
  // à chaque enregistrement ferait clignoter la maison dans l'app d'Apple.
  if (pontAChange(avant, next.homekit) || listeAChange(next)) {
    try {
      await pont.start(next);
    } catch (e) {
      console.warn(`[homekit] ${(e as Error).message}`);
    }
  }

  return { ok: true, config: next, warnings: issues.filter((i) => !isBlocking(i)) };
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
 * téléphone le trouve — y compris à travers le tunnel, qui place le téléphone
 * sur le même réseau.
 */
let annonce: { stop: () => void } | null = null;
try {
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

const pruner = setInterval(() => db.prune(), 12 * 3_600_000);
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

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`[http] http://localhost:${PORT}  ·  base ${DB_FILE}`);
} catch (err) {
  // Une trace de pile de vingt lignes pour un port occupé n'aide personne :
  // on dit ce qui se passe et ce qu'il faut faire.
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `\n[http] Le port ${PORT} est déjà utilisé — un autre serveur tourne probablement.\n` +
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
