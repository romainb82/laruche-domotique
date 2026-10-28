import {
  SIM_CONNECTION,
  type Candidate,
  type Capability,
  type Command,
  type Connection,
  type ConnectionStatus,
  type DeviceConfig,
  type HouseConfig,
} from '@domo/shared';
import type { Adapter, AdapterContext, PatchHandler } from './adapter.js';
import { SimAdapter } from './sim.js';
import { MqttAdapter } from './mqtt.js';
import { HttpAdapter } from './http.js';
import { ModbusAdapter } from './modbus.js';
import { HomeAssistantAdapter } from './homeassistant.js';

/**
 * Le registre : le cerveau de la connectivité.
 *
 * Il fait tourner plusieurs adaptateurs en même temps et aiguille chaque
 * équipement vers le sien. Deux règles simples le gouvernent :
 *
 *   · un équipement sans raccordement est servi par le SIMULATEUR ;
 *   · un adaptateur en panne n'empêche jamais les autres de fonctionner.
 *
 * La seconde est la plus importante : le jour où le broker tombe, la maison ne
 * doit pas perdre ses pièces encore simulées, ni son interface.
 */
export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();
  /** deviceId → id de la connexion qui le sert réellement. */
  private routage = new Map<string, string>();
  /**
   * Le message d'échec du DÉMARRAGE, par connexion. Il ne sert qu'à
   * l'affichage, tant que l'adaptateur n'a pas réussi à se connecter depuis :
   * un broker qui démarre après le serveur finit par répondre, et la
   * connexion doit alors redevenir utilisable sans qu'on réenregistre quoi
   * que ce soit.
   */
  private erreurs = new Map<string, string>();
  /** Vrai dès que `stop()` est demandé : un `start()` encore en cours s'arrête là. */
  private arrete = false;

  constructor(
    private config: HouseConfig,
    private emit: PatchHandler,
    private warn: (m: string) => void = () => {},
    private courant?: (deviceId: string) => Capability[],
  ) {}

  async start(): Promise<void> {
    const connexions = this.connexionsUtiles();
    this.arrete = false;

    for (const connexion of connexions) {
      // Un `stop()` survenu pendant qu'un canal lent se connectait : double
      // clic sur « Enregistrer » : ne doit pas laisser ce registre continuer
      // à ouvrir des canaux que plus personne n'arrêtera.
      if (this.arrete) return;

      const servis = this.equipementsDe(connexion.id);
      const adapter = this.fabriquer(connexion);
      if (!adapter) continue;

      this.adapters.set(connexion.id, adapter);
      await adapter.attach(servis);
      for (const d of servis) this.routage.set(d.id, connexion.id);

      if (!connexion.enabled) continue;

      try {
        await adapter.start();
        this.erreurs.delete(connexion.id);
        if (this.arrete) {
          await adapter.stop().catch(() => undefined);
          return;
        }
      } catch (e) {
        // Une connexion qui échoue ne fait pas tomber le serveur : on note, on
        // le remonte à l'interface, et on continue avec les autres.
        const message = (e as Error).message;
        this.erreurs.set(connexion.id, message);
        this.warn(`[${connexion.label}] ${message}`);
      }
    }
  }

  async stop(): Promise<void> {
    this.arrete = true;
    await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()));
    this.adapters.clear();
    this.routage.clear();
    this.erreurs.clear();
  }

  async command(device: DeviceConfig, command: Command): Promise<void> {
    const connexionId = this.routage.get(device.id) ?? SIM_CONNECTION;
    const adapter = this.adapters.get(connexionId);
    if (!adapter) throw new Error(`Aucun canal actif pour « ${device.label} ».`);

    // On regarde l'état VIVANT du canal, pas l'erreur figée au démarrage :
    // un broker revenu entre-temps doit accepter la commande.
    const vivant = adapter.status().state;
    if (vivant === 'error') {
      const panne = adapter.status().detail ?? this.erreurs.get(connexionId);
      throw new Error(panne ?? 'Le canal ne répond pas.');
    }

    await adapter.command(device, command);
  }

  /** Quel canal sert cet équipement : c'est ce que l'interface affiche. */
  canalDe(deviceId: string): string {
    return this.routage.get(deviceId) ?? SIM_CONNECTION;
  }

  statuses(): ConnectionStatus[] {
    return this.config.connections.map((c) => {
      const adapter = this.adapters.get(c.id);
      const base = adapter?.status();
      // L'erreur de démarrage ne vaut que tant que le canal n'a pas réussi à
      // se connecter depuis.
      const panne = base?.state === 'connected' ? undefined : this.erreurs.get(c.id);

      if (!c.enabled) {
        return {
          id: c.id, kind: c.kind, label: c.label,
          state: 'disabled' as const, detail: 'Connexion au repos.',
          devices: base?.devices ?? 0, lastEvent: base?.lastEvent ?? null,
        };
      }
      if (panne) {
        return {
          id: c.id, kind: c.kind, label: c.label,
          state: 'error' as const, detail: panne,
          devices: base?.devices ?? 0, lastEvent: base?.lastEvent ?? null,
        };
      }
      return (
        base ?? {
          id: c.id, kind: c.kind, label: c.label,
          state: 'error' as const, detail: 'Canal non démarré.',
          devices: 0, lastEvent: null,
        }
      );
    });
  }

  /** Tout ce que les adaptateurs ont entendu sans savoir à qui l'attribuer. */
  candidates(): Candidate[] {
    return [...this.adapters.values()]
      .flatMap((a) => a.candidates())
      .sort((a, b) => b.count - a.count)
      .slice(0, 300);
  }

  clearCandidates(connectionId?: string): void {
    for (const [id, a] of this.adapters) {
      if (!connectionId || id === connectionId) a.clearCandidates();
    }
  }

  // ------------------------------------------------------------------ privé

  /**
   * Les connexions à démarrer. Le simulateur est ajouté d'office même s'il a
   * été supprimé de la configuration : sans lui, un équipement non raccordé
   * n'aurait personne pour le servir.
   */
  private connexionsUtiles(): Connection[] {
    const liste = [...this.config.connections];
    if (!liste.some((c) => c.id === SIM_CONNECTION)) {
      liste.unshift({
        id: SIM_CONNECTION, kind: 'sim', label: 'Simulateur', enabled: true, settings: {},
      });
    }
    return liste;
  }

  /**
   * Les équipements servis par une connexion.
   * Le simulateur récupère tout ce qui n'est pas raccordé, et aussi ce qui
   * pointe vers une connexion désactivée ou disparue, sinon un broker mis au
   * repos rendrait la moitié de la maison muette.
   */
  private equipementsDe(connexionId: string): DeviceConfig[] {
    const actives = new Set(
      this.config.connections.filter((c) => c.enabled).map((c) => c.id),
    );

    return this.config.devices.filter((d) => {
      const cible = d.binding?.connectionId;
      const raccorde = !!cible && actives.has(cible) && cible !== SIM_CONNECTION;
      return raccorde ? cible === connexionId : connexionId === SIM_CONNECTION;
    });
  }

  private fabriquer(connexion: Connection): Adapter | null {
    const ctx: AdapterContext = {
      connection: connexion, emit: this.emit, warn: this.warn, courant: this.courant,
    };
    switch (connexion.kind) {
      case 'sim': return new SimAdapter(ctx);
      case 'mqtt': return new MqttAdapter(ctx);
      case 'http': return new HttpAdapter(ctx);
      case 'modbus': return new ModbusAdapter(ctx);
      case 'homeassistant': return new HomeAssistantAdapter(ctx);
      default:
        this.warn(`Type de connexion inconnu : ${String(connexion.kind)}`);
        return null;
    }
  }
}
