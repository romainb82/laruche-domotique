import {
  applyPipeline, inspectPayload, readPath, renderPayload,
  type Capability, type CapField, type Command, type DeviceConfig,
} from '@domo/shared';
import { BaseAdapter, type AdapterContext } from './adapter.js';
import { poser } from './champs.js';
import { valeurDe } from './mqtt.js';

/**
 * Le canal HTTP.
 *
 * Beaucoup de matériel n'a pas de MQTT mais expose une API : régulateurs de
 * piscine, passerelles constructeur, onduleurs. On les interroge à intervalle
 * régulier et on traduit leur réponse avec exactement la même chaîne de
 * transformations que MQTT : le moteur ignore d'où vient la valeur.
 *
 * Les lectures qui partagent un même point d'entrée sont regroupées : une seule
 * requête sert tous les capteurs d'une même passerelle.
 */
export class HttpAdapter extends BaseAdapter {
  private timer: NodeJS.Timeout | null = null;
  private base = '';
  private headers: Record<string, string> = {};
  /** point d'entrée → lectures qui en dépendent */
  private sources = new Map<string, { device: DeviceConfig; read: DeviceConfig['binding'] extends null ? never : any }[]>();

  constructor(ctx: AdapterContext) {
    super(ctx);
    this.base = (ctx.connection.settings.baseUrl ?? '').replace(/\/+$/, '');
    this.headers = ctx.connection.settings.headers ?? {};
  }

  async start(): Promise<void> {
    if (!this.base) throw new Error('Adresse de base manquante.');
    this.marquer('connecting');

    // On sonde l'adresse AVANT de se déclarer prêt. Sans ça, un canal sans
    // équipement rattaché : le cas d'un essai à blanc : ne ferait aucune
    // requête et répondrait « ça marche » sur une adresse morte. Un essai qui
    // réussit toujours est pire qu'inutile.
    await this.sonder();

    const periode = Math.max(2, this.ctx.connection.settings.pollSeconds ?? 30) * 1000;
    this.timer = setInterval(() => void this.interroger(), periode);
    this.timer.unref?.();

    await this.interroger();
    if (this.etat === 'connecting') this.marquer('connected');
  }

  /**
   * Vérifie que quelqu'un répond à l'adresse de base.
   *
   * Un 404 est acceptable : beaucoup d'API ne servent rien à leur racine. Ce
   * qu'on cherche, c'est une réponse : n'importe laquelle. Seule une panne de
   * transport (connexion refusée, nom inconnu, silence) est un échec.
   */
  private async sonder(): Promise<void> {
    const cible = this.sources.size ? this.url([...this.sources.keys()][0]!) : this.base;
    try {
      await fetch(cible, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    } catch (e) {
      throw new Error(humaniser(e as Error, cible));
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sources.clear();
    this.marquer('disabled');
  }

  async attach(devices: DeviceConfig[]): Promise<void> {
    await super.attach(devices);
    this.sources.clear();
    for (const d of devices) {
      for (const read of d.binding?.reads ?? []) {
        if (!read.source) continue;
        const liste = this.sources.get(read.source) ?? [];
        liste.push({ device: d, read });
        this.sources.set(read.source, liste);
      }
    }
  }

  async command(device: DeviceConfig, command: Command): Promise<void> {
    const writes = (device.binding?.writes ?? []).filter((w) => w.on === command.kind);
    if (!writes.length)
      throw new Error(`« ${device.label} » n'a pas d'écriture déclarée pour cette commande.`);

    for (const w of writes) {
      const brut = valeurDe(command);
      const transforme = w.pipeline.length ? applyPipeline(brut, w.pipeline) : brut;
      const corps = renderPayload(w.payload, transforme);
      const cible = renderPayload(this.url(w.target), transforme);

      const res = await fetch(cible, {
        method: w.method,
        headers: { 'content-type': 'application/json', ...this.headers },
        body: w.method === 'GET' ? undefined : corps,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`${cible} a répondu ${res.status}.`);
    }
  }

  private async interroger(): Promise<void> {
    if (!this.sources.size) return;

    for (const [source, cibles] of this.sources) {
      try {
        const res = await fetch(this.url(source), {
          headers: this.headers,
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) { this.marquer('error', `${source} a répondu ${res.status}.`); continue; }

        const raw = await res.text();
        this.marquer('connected');

        const parEquipement = new Map<string, { device: DeviceConfig; caps: Capability[] }>();
        for (const { device, read } of cibles) {
          const brut = readPath(raw, read.path);
          if (brut === undefined) continue;
          const valeur = read.pipeline.length ? applyPipeline(brut, read.pipeline) : brut;
          if (valeur === undefined) continue;
          const e = parEquipement.get(device.id) ?? { device, caps: [] };
          e.caps = poser(e.caps, device, read.into as CapField, valeur);
          parEquipement.set(device.id, e);
        }
        for (const { device, caps } of parEquipement.values()) {
          if (caps.length) this.ctx.emit({ deviceId: device.id, caps });
        }

        // On garde une trace de ce que le point d'entrée expose : ça sert à
        // proposer les autres champs disponibles au moment du raccordement.
        this.noterCandidat(source, raw.slice(0, 200), inspectPayload(raw));
      } catch (e) {
        this.marquer('error', humaniser(e as Error, source));
      }
    }
  }

  private url(chemin: string): string {
    if (/^https?:\/\//i.test(chemin)) return chemin;
    return `${this.base}/${chemin.replace(/^\/+/, '')}`;
  }
}

/**
 * Node empile les échecs successifs dans une `AggregateError` au message vide.
 * On va chercher la vraie cause dedans plutôt que d'afficher le nom de la
 * classe d'erreur à quelqu'un qui a mal tapé une adresse.
 */
function humaniser(e: Error, source: string): string {
  const enveloppe = e as Error & { errors?: Error[]; cause?: unknown };

  // `fetch` de Node emballe l'échec réel dans `cause` et se contente d'un
  // « fetch failed » en surface. On descend chercher ce qui s'est vraiment passé.
  if (enveloppe.errors?.length) {
    const causes = enveloppe.errors.map((x) => humaniser(x, source));
    return causes.find((c) => !c.includes('failed')) ?? causes[0] ?? `${source} injoignable.`;
  }
  if (enveloppe.cause instanceof Error) return humaniser(enveloppe.cause, source);

  const m = e.message || String(e);
  if (e.name === 'TimeoutError' || m.includes('timeout')) return `${source} ne répond pas.`;
  if (m.includes('ECONNREFUSED')) return `Connexion refusée sur ${source}.`;
  if (m.includes('ENOTFOUND') || m.includes('EAI_AGAIN')) return `Adresse introuvable : ${source}.`;
  if (m.includes('EHOSTUNREACH') || m.includes('ENETUNREACH')) return `Réseau injoignable depuis le serveur.`;
  // Node refuse une poignée de ports réservés (7, 9, 19…) avant même d'essayer.
  if (m.includes('bad port')) return `Port interdit dans ${source} : choisis un autre numéro.`;
  return m || `${source} injoignable.`;
}
