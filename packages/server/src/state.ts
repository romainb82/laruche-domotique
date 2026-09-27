import { EventEmitter } from 'node:events';
import type {
  ActionOrigin,
  Capability,
  Command,
  DeviceConfig,
  DeviceState,
  HouseConfig,
} from '@domo/shared';
import type { Candidate, ConnectionStatus } from '@domo/shared';
import { AdapterRegistry } from './adapters/registry.js';
import { initialCaps } from './drivers/driver.js';
import type { Db } from './db.js';

/**
 * Le hub d'état.
 *
 * Deux règles y sont tenues, et tout le reste en découle :
 *
 *  1. L'état vient TOUJOURS du driver, jamais de la commande. On n'écrit pas
 *     « la lampe est allumée » parce qu'on a demandé de l'allumer.
 *  2. Entre l'envoi d'une commande et sa confirmation, l'équipement est
 *     `pending` — l'interface affiche « en cours », un troisième état.
 *     Si la confirmation n'arrive pas, on affiche l'échec au lieu de le masquer.
 */
export class StateHub extends EventEmitter {
  private states = new Map<string, DeviceState>();
  private devices = new Map<string, DeviceConfig>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private registry: AdapterRegistry | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  /** Dernière écriture par équipement : le débit est bridé équipement par équipement. */
  private dernierEcrit = new Map<string, number>();

  constructor(
    private config: HouseConfig,
    private db: Db,
  ) {
    super();
    this.setMaxListeners(0);
  }

  /** Les canaux actifs, avec leur santé — c'est ce que l'interface affiche. */
  connections(): ConnectionStatus[] {
    return this.registry?.statuses() ?? [];
  }

  /** Ce que les adaptateurs ont entendu sans savoir à qui l'attribuer. */
  candidates(): Candidate[] {
    return this.registry?.candidates() ?? [];
  }

  clearCandidates(connectionId?: string): void {
    this.registry?.clearCandidates(connectionId);
  }

  /** Quel canal sert cet équipement. */
  canalDe(deviceId: string): string {
    return this.registry?.canalDe(deviceId) ?? 'sim';
  }

  async start(): Promise<void> {
    this.indexDevices();

    // Chaque équipement démarre avec un état plausible : l'interface ne
    // s'ouvre jamais sur du vide, même avant la première nouvelle du matériel.
    for (const d of this.devices.values()) {
      this.states.set(d.id, {
        id: d.id,
        caps: initialCaps(d),
        health: d.binding ? 'offline' : 'online',
        lastSeen: new Date().toISOString(),
        pending: false,
      });
    }

    this.registry = new AdapterRegistry(
      this.config,
      ({ deviceId, caps }) => this.ingest(deviceId, caps),
      (m) => this.emit('warn', m),
    );

    // Le registre encaisse lui-même les pannes de canal : un broker
    // injoignable ne doit pas empêcher l'application de démarrer.
    await this.registry.start();

    this.staleTimer = setInterval(() => this.checkStale(), 15_000);
    this.staleTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.staleTimer) clearInterval(this.staleTimer);
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    await this.registry?.stop();
    this.registry = null;
  }

  /** Rechargement à chaud après une modification de configuration. */
  async reload(config: HouseConfig): Promise<void> {
    await this.stop();
    this.config = config;
    this.states.clear();
    await this.start();
    this.emit('reload');
  }

  snapshot(): DeviceState[] {
    return [...this.states.values()];
  }

  get(id: string): DeviceState | undefined {
    return this.states.get(id);
  }

  async command(id: string, command: Command, origin: ActionOrigin = 'ui'): Promise<void> {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Équipement inconnu : ${id}`);
    if (!this.registry) throw new Error('Aucun canal actif.');

    this.markPending(id, true);

    try {
      await this.registry.command(device, command);
      // La commande est *transmise*, pas appliquée. On laisse `pending` en place :
      // c'est le retour du matériel qui le lèvera, ou le délai de garde.
      this.armTimeout(id, command, origin);
    } catch (err) {
      this.markPending(id, false);
      this.db.logAction(id, command, origin, 'rejected');
      throw err;
    }
  }

  // -------------------------------------------------------------- ingestion

  private ingest(id: string, caps: Capability[]): void {
    const device = this.devices.get(id);
    if (!device) return;

    const previous = this.states.get(id);
    // Un adaptateur n'annonce que ce qu'il vient d'apprendre : un module qui
    // publie sa position ne dit rien de sa consigne. On fusionne donc au lieu
    // de remplacer, sinon chaque message effacerait les autres capacités.
    const fusion = fusionnerCaps(previous?.caps ?? [], caps);
    const stillMoving = fusion.some((c) => c.kind === 'cover' && c.moving !== null);

    const next: DeviceState = {
      id,
      caps: fusion,
      health: 'online',
      lastSeen: new Date().toISOString(),
      pending: stillMoving,
    };

    this.states.set(id, next);

    if (!stillMoving && previous?.pending) this.confirm(id);

    this.persistReadings(device, fusion);
    this.emit('state', next);
  }

  private confirm(id: string): void {
    const timer = this.pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
    }
  }

  private markPending(id: string, pending: boolean): void {
    const current = this.states.get(id);
    if (!current) return;
    const next = { ...current, pending };
    this.states.set(id, next);
    this.emit('state', next);
  }

  /**
   * Délai de garde. Sans lui, une commande perdue laisse l'interface
   * éternellement « en cours » — le pire des trois états.
   */
  private armTimeout(id: string, command: Command, origin: ActionOrigin): void {
    this.confirm(id);
    const device = this.devices.get(id);
    const budget = command.kind === 'cover' ? ((device?.sim.travelSeconds ?? 22) + 8) * 1000 : 8_000;

    const timer = setTimeout(() => {
      this.pendingTimers.delete(id);
      const current = this.states.get(id);
      if (!current?.pending) return;
      this.states.set(id, { ...current, pending: false, health: 'stale' });
      this.db.logAction(id, command, origin, 'timeout');
      this.emit('state', this.states.get(id)!);
    }, budget);
    timer.unref?.();

    this.pendingTimers.set(id, timer);
    this.db.logAction(id, command, origin, 'confirmed');
  }

  /**
   * Un capteur sur pile qui meurt ne renvoie pas d'erreur : il se tait.
   * Sans cette vérification, le système régule sur un fantôme.
   */
  private checkStale(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      const device = this.devices.get(id);
      if (!device || state.health === 'offline') continue;
      const age = (now - Date.parse(state.lastSeen)) / 1000;
      const health = age > device.staleAfterSeconds ? 'stale' : 'online';
      if (health !== state.health) {
        const next = { ...state, health } as DeviceState;
        this.states.set(id, next);
        this.emit('state', next);
      }
    }
  }

  /** Historisation des mesures — échantillonnée, pas à chaque tick. */
  /**
   * Historise les mesures, au plus une par seconde ET PAR ÉQUIPEMENT.
   *
   * La limite était globale : le capteur le plus bavard raflait le quota et
   * les autres n'étaient presque jamais enregistrés. Mesuré sur un mois de
   * fonctionnement — 9 761 points pour la puissance, 358 pour toutes les
   * températures réunies. Un historique aussi troué rend l'intégration de
   * l'énergie fausse et les courbes de température illisibles.
   */
  private persistReadings(device: DeviceConfig, caps: Capability[]): void {
    const now = Date.now();
    if (now - (this.dernierEcrit.get(device.id) ?? 0) < 1_000) return;
    this.dernierEcrit.set(device.id, now);

    for (const cap of caps) {
      if (cap.kind === 'sensor') this.db.recordReading(device.id, cap.metric, cap.value);
      else if (cap.kind === 'climate') this.db.recordReading(device.id, 'temperature', cap.ambient);
    }
  }

  private indexDevices(): void {
    this.devices.clear();
    for (const d of this.config.devices) this.devices.set(d.id, d);
  }
}

/**
 * Fusionne des capacités partielles dans l'état courant.
 * Une capacité annoncée remplace celle de même nature ; les autres survivent.
 */
function fusionnerCaps(courant: Capability[], arrivant: Capability[]): Capability[] {
  if (!courant.length) return arrivant;
  const sortie = [...courant];
  for (const cap of arrivant) {
    const i = sortie.findIndex((c) => c.kind === cap.kind);
    if (i >= 0) sortie[i] = cap;
    else sortie.push(cap);
  }
  return sortie;
}
