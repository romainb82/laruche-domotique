import mqtt, { type MqttClient } from 'mqtt';
import {
  applyPipeline,
  inspectPayload,
  readPath,
  renderPayload,
  type Capability,
  type CapField,
  type Command,
  type DeviceConfig,
  type ReadSpec,
} from '@domo/shared';
import { BaseAdapter, type AdapterContext } from './adapter.js';
import { poser } from './champs.js';

/**
 * Le canal MQTT.
 *
 * Un seul adaptateur pour tout ce qui parle MQTT : Shelly, Zigbee2MQTT,
 * Tasmota, ESPHome, un script maison. La différence entre ces matériels ne vit
 * pas dans du code mais dans les lectures et écritures déclarées par
 * l'utilisateur, traduites par la chaîne de transformations.
 *
 * C'est ce qui rend tenable un backend maison : on n'écrit pas un driver par
 * marque, on décrit un raccordement.
 */
export class MqttAdapter extends BaseAdapter {
  private client: MqttClient | null = null;
  /** topic → équipements et lectures concernés (plusieurs peuvent partager un topic). */
  private abonnements = new Map<string, { device: DeviceConfig; read: ReadSpec }[]>();
  private racine: string;

  constructor(ctx: AdapterContext) {
    super(ctx);
    this.racine = (ctx.connection.settings.baseTopic ?? '').replace(/\/+$/, '');
  }

  async start(): Promise<void> {
    const url = this.ctx.connection.settings.url;
    if (!url) throw new Error('Adresse du broker manquante.');

    this.marquer('connecting');

    this.client = mqtt.connect(url, {
      username: this.ctx.connection.settings.username || undefined,
      password: this.ctx.connection.settings.password || undefined,
      reconnectPeriod: 5_000,
      connectTimeout: 8_000,
      clientId: `domo-${this.id}-${Math.random().toString(16).slice(2, 8)}`,
    });

    this.client.on('connect', () => {
      this.marquer('connected');
      void this.souscrire();
    });
    this.client.on('reconnect', () => this.marquer('connecting'));
    this.client.on('error', (e) => this.marquer('error', lisible(e)));
    this.client.on('close', () => {
      if (this.etat === 'connected') this.marquer('connecting', 'Connexion perdue, reprise en cours.');
    });
    this.client.on('message', (topic, payload) => this.recevoir(topic, payload.toString()));

    await new Promise<void>((resolve, reject) => {
      const c = this.client;
      if (!c) return reject(new Error('client MQTT absent'));
      const ok = () => { fin(); resolve(); };
      const ko = (e: Error) => { fin(); reject(new Error(lisible(e))); };
      const fin = () => { c.off('connect', ok); c.off('error', ko); clearTimeout(minuteur); };
      // Un broker injoignable ne doit pas figer le démarrage du serveur.
      const minuteur = setTimeout(() => { fin(); reject(new Error('Le broker ne répond pas.')); }, 9_000);
      c.once('connect', ok);
      c.once('error', ko);
    });
  }

  async stop(): Promise<void> {
    this.abonnements.clear();
    const c = this.client;
    this.client = null;
    this.marquer('disabled');
    if (c) await c.endAsync(true).catch(() => undefined);
  }

  async attach(devices: DeviceConfig[]): Promise<void> {
    await super.attach(devices);
    this.abonnements.clear();

    for (const d of devices) {
      for (const read of d.binding?.reads ?? []) {
        if (!read.source) continue;
        const topic = this.absolu(read.source);
        const liste = this.abonnements.get(topic) ?? [];
        liste.push({ device: d, read });
        this.abonnements.set(topic, liste);
      }
    }
    if (this.client?.connected) await this.souscrire();
  }

  async command(device: DeviceConfig, command: Command): Promise<void> {
    if (!this.client?.connected) throw new Error('Broker MQTT non connecté.');

    const writes = (device.binding?.writes ?? []).filter((w) => w.on === command.kind);
    if (!writes.length)
      throw new Error(`« ${device.label} » n'a pas d'écriture déclarée pour cette commande.`);

    for (const w of writes) {
      const brut = valeurDe(command);
      const transforme = w.pipeline.length ? applyPipeline(brut, w.pipeline) : brut;
      await this.client.publishAsync(this.absolu(w.target), renderPayload(w.payload, transforme));
    }
  }

  // ------------------------------------------------------------- réception

  private recevoir(topic: string, raw: string): void {
    const cibles = this.abonnements.get(topic);

    if (!cibles?.length) {
      // Personne ne réclame ce topic : c'est un candidat à la découverte.
      this.noterCandidat(this.relatif(topic), tronquer(raw), inspectPayload(raw));
      return;
    }

    this.dernier = new Date().toISOString();

    // Un même topic peut alimenter plusieurs équipements et plusieurs champs.
    const parEquipement = new Map<string, { device: DeviceConfig; caps: Capability[] }>();

    for (const { device, read } of cibles) {
      const brut = readPath(raw, read.path);
      if (brut === undefined) continue;
      const valeur = read.pipeline.length ? applyPipeline(brut, read.pipeline) : brut;
      if (valeur === undefined) continue;

      const entree = parEquipement.get(device.id) ?? { device, caps: [] };
      entree.caps = poser(entree.caps, device, read.into as CapField, valeur);
      parEquipement.set(device.id, entree);
    }

    for (const { device, caps } of parEquipement.values()) {
      if (caps.length) this.ctx.emit({ deviceId: device.id, caps });
    }
  }

  private async souscrire(): Promise<void> {
    const c = this.client;
    if (!c) return;

    const topics = [...this.abonnements.keys()];
    if (topics.length) await c.subscribeAsync(topics).catch((e) => this.ctx.warn(lisible(e)));

    // Écoute large pour la découverte. Limitée à la racine configurée : sans
    // ça, sur un broker partagé, on se noierait sous le trafic des voisins.
    if (this.racine) {
      await c.subscribeAsync(`${this.racine}/#`, { qos: 0 }).catch(() => undefined);
    }
  }

  /** Un topic déclaré sans racine est relatif au préfixe de la connexion. */
  private absolu(source: string): string {
    if (!this.racine || source.startsWith(`${this.racine}/`)) return source;
    return `${this.racine}/${source.replace(/^\/+/, '')}`;
  }

  private relatif(topic: string): string {
    return this.racine && topic.startsWith(`${this.racine}/`)
      ? topic.slice(this.racine.length + 1)
      : topic;
  }
}

/** La valeur que porte une commande, avant transformation. */
export function valeurDe(command: Command): unknown {
  switch (command.kind) {
    case 'switch': return command.state;
    case 'dim': return command.level;
    case 'cover': return command.position;
    case 'cover-stop': return 'stop';
    case 'climate': return command.setpoint;
  }
}

function tronquer(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Les messages de la bibliothèque MQTT sont cryptiques ; on les humanise.
 *
 * Node empile les échecs successifs (IPv6 puis IPv4…) dans une `AggregateError`
 * dont le message est vide. Afficher « AggregateError » à quelqu'un qui a mal
 * tapé une adresse est une non-réponse : on va chercher la vraie cause dedans.
 */
function lisible(e: Error): string {
  const agrege = e as Error & { errors?: Error[] };
  if (agrege.errors?.length) {
    const causes = agrege.errors.map((x) => lisible(x));
    return causes.find((c) => !c.startsWith('Aggregate')) ?? causes[0] ?? 'Connexion impossible.';
  }
  const m = e.message || String(e);
  if (m.includes('ECONNREFUSED')) return "Le broker refuse la connexion : vérifie l'adresse et le port.";
  if (m.includes('ENOTFOUND') || m.includes('EAI_AGAIN')) return "Adresse du broker introuvable.";
  if (m.includes('ETIMEDOUT')) return 'Le broker ne répond pas.';
  // « connack timeout » : la socket s'ouvre mais l'échange MQTT n'aboutit pas.
  // C'est le symptôme d'une adresse dans le vide ou d'un pare-feu.
  if (m.toLowerCase().includes('connack')) return "Aucune réponse MQTT : l'adresse est-elle bien celle d'un broker ?";
  if (m.toLowerCase().includes('not authorized')) return 'Identifiants refusés par le broker.';
  if (m.includes('EHOSTUNREACH') || m.includes('ENETUNREACH')) return 'Réseau injoignable depuis le serveur.';
  return m || 'Connexion impossible.';
}
