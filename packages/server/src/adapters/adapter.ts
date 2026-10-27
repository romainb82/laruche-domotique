import type {
  Candidate,
  Capability,
  Command,
  Connection,
  ConnectionStatus,
  DeviceConfig,
} from '@domo/shared';

/**
 * Un adaptateur = un canal vers le monde extérieur.
 *
 * Le changement de fond par rapport au driver unique : **plusieurs adaptateurs
 * tournent en même temps**. Une maison réelle a un broker MQTT pour les
 * modules, une API HTTP pour la piscine, plus tard du Modbus pour la pompe à
 * chaleur, et le simulateur pour tout ce qui n'est pas encore installé.
 *
 * Chaque équipement choisit sa connexion. Aucun ne choisit pour les autres.
 */
export interface Adapter {
  readonly id: string;
  readonly kind: Connection['kind'];

  /** Ouvre le canal. Doit rejeter si la connexion est impossible. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Déclare les équipements servis par cet adaptateur. */
  attach(devices: DeviceConfig[]): Promise<void>;

  /**
   * Transmet une commande. Tenir la promesse signifie « transmise », jamais
   * « appliquée » : la confirmation revient par le flux d'états.
   */
  command(device: DeviceConfig, command: Command): Promise<void>;

  /** État vivant du canal, pour que l'interface sache quoi dire à l'humain. */
  status(): ConnectionStatus;

  /**
   * Ce que l'adaptateur a entendu passer sans savoir à qui l'attribuer.
   * C'est la base de la découverte : on n'oblige jamais à deviner un topic.
   */
  candidates(): Candidate[];

  /** Vide la liste des candidats : après adoption, ou sur demande. */
  clearCandidates(): void;
}

/** Émis dès qu'une information fraîche arrive du matériel. */
export type StatePatch = {
  deviceId: string;
  /** Capacités partielles : on ne réécrit que ce qu'on vient d'apprendre. */
  caps: Capability[];
};

export type PatchHandler = (patch: StatePatch) => void;

export interface AdapterContext {
  connection: Connection;
  emit: PatchHandler;
  /** Journalise sans faire tomber le serveur. */
  warn: (message: string) => void;
}

/** Base commune : gestion du statut et des candidats, identique partout. */
export abstract class BaseAdapter implements Adapter {
  readonly id: string;
  readonly kind: Connection['kind'];

  protected devices = new Map<string, DeviceConfig>();
  protected etat: ConnectionStatus['state'] = 'disabled';
  protected detail: string | null = null;
  protected dernier: string | null = null;

  private vus = new Map<string, Candidate>();

  constructor(protected ctx: AdapterContext) {
    this.id = ctx.connection.id;
    this.kind = ctx.connection.kind;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract command(device: DeviceConfig, command: Command): Promise<void>;

  async attach(devices: DeviceConfig[]): Promise<void> {
    this.devices.clear();
    for (const d of devices) this.devices.set(d.id, d);
  }

  status(): ConnectionStatus {
    return {
      id: this.id,
      kind: this.kind,
      label: this.ctx.connection.label,
      state: this.etat,
      detail: this.detail,
      devices: this.devices.size,
      lastEvent: this.dernier,
    };
  }

  candidates(): Candidate[] {
    // Les plus bavards d'abord : c'est presque toujours ce qu'on cherche.
    return [...this.vus.values()].sort((a, b) => b.count - a.count);
  }

  clearCandidates(): void {
    this.vus.clear();
  }

  /** À appeler quand on entend une source qu'aucun équipement ne réclame. */
  protected noterCandidat(source: string, sample: string, paths: Candidate['paths']): void {
    const key = `${this.id}::${source}`;
    const now = new Date().toISOString();
    const existant = this.vus.get(key);
    if (existant) {
      existant.lastSeen = now;
      existant.count++;
      existant.sample = sample;
      existant.paths = paths;
      return;
    }
    // Plafond volontaire : un broker partagé peut être très bavard, et une
    // liste de découverte infinie n'aide personne.
    if (this.vus.size >= 200) return;
    this.vus.set(key, {
      key,
      connectionId: this.id,
      source,
      sample,
      paths,
      firstSeen: now,
      lastSeen: now,
      count: 1,
    });
  }

  protected marquer(etat: ConnectionStatus['state'], detail: string | null = null): void {
    this.etat = etat;
    this.detail = detail;
    this.dernier = new Date().toISOString();
  }
}
