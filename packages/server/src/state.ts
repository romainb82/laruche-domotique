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
 *     `pending` : l'interface affiche « en cours », un troisième état.
 *     Si la confirmation n'arrive pas, on affiche l'échec au lieu de le masquer.
 */
export class StateHub extends EventEmitter {
  private states = new Map<string, DeviceState>();
  private devices = new Map<string, DeviceConfig>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  /** La commande en attente de confirmation, par équipement. */
  private attentes = new Map<string, { command: Command; origin: ActionOrigin }>();
  /** Avertissements d'ingestion, bridés : une trame cassée en boucle ne doit pas noyer le journal. */
  private dernierAvertissement = new Map<string, number>();
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

  /** Les canaux actifs, avec leur santé : c'est ce que l'interface affiche. */
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
      ({ deviceId, caps }) => this.ingerer(deviceId, caps),
      (m) => this.emit('warn', m),
      (deviceId) => this.states.get(deviceId)?.caps ?? [],
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
    this.attentes.clear();
    await this.registry?.stop();
    this.registry = null;
  }

  /**
   * Rechargement à chaud après une modification de configuration.
   *
   * Sérialisé : deux rechargements rapprochés s'enchaînent au lieu de se
   * chevaucher. Sans cette file, le second `stop()` vidait le registre que le
   * premier `start()` était encore en train de remplir, et les canaux ouverts
   * ensuite n'avaient plus personne pour les arrêter.
   */
  private rechargement: Promise<void> = Promise.resolve();

  reload(config: HouseConfig): Promise<void> {
    const tour = this.rechargement.then(async () => {
      await this.stop();
      this.config = config;
      this.states.clear();
      await this.start();
      this.emit('reload');
    });
    this.rechargement = tour.catch(() => undefined);
    return tour;
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
      this.journaliser(id, command, origin, 'rejected');
      throw err;
    }
  }

  // -------------------------------------------------------------- ingestion

  /**
   * La cloison. Tout ce qui vient du matériel passe par ici, et rien de ce
   * qui s'y passe ne doit faire tomber le serveur : une trame malformée, un
   * pipeline mal configuré ou un disque plein se journalisent et c'est tout.
   * Un serveur qui meurt sur un message, c'est une maison sans pilotage, et
   * qui remeurt au message suivant après chaque redémarrage.
   */
  private ingerer(id: string, caps: Capability[]): void {
    try {
      this.ingest(id, caps);
    } catch (e) {
      const now = Date.now();
      if (now - (this.dernierAvertissement.get(id) ?? 0) > 60_000) {
        this.dernierAvertissement.set(id, now);
        this.emit('warn', `[${id}] nouvelle du matériel ignorée : ${(e as Error).message}`);
      }
    }
  }

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

    if (!stillMoving && previous?.pending) {
      // Toute nouvelle du matériel ne vaut pas confirmation : un relevé
      // périodique parti AVANT la commande répète l'ancien état. On ne lève
      // `pending` que si ce qu'on reçoit correspond à ce qu'on a demandé ;
      // sinon on attend la suite, ou le délai de garde.
      const attendu = this.attentes.get(id);
      if (!attendu || correspond(fusion, attendu.command)) this.confirm(id);
      else next.pending = true;
    }

    this.states.set(id, next);
    this.persistReadings(device, fusion);
    this.emit('state', next);
  }

  private confirm(id: string): void {
    const timer = this.pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
    }
    const attendu = this.attentes.get(id);
    if (attendu) {
      this.attentes.delete(id);
      // « confirmée » s'écrit quand le matériel a répondu, pas à l'envoi.
      this.journaliser(id, attendu.command, attendu.origin, 'confirmed');
    }
  }

  /** Le journal ne doit jamais faire tomber une commande : un disque plein se dit, c'est tout. */
  private journaliser(
    id: string,
    command: Command,
    origin: ActionOrigin,
    outcome: 'confirmed' | 'timeout' | 'rejected',
  ): void {
    try {
      this.db.logAction(id, command, origin, outcome);
    } catch (e) {
      this.emit('warn', `[journal] écriture impossible : ${(e as Error).message}`);
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
   * éternellement « en cours » : le pire des trois états.
   */
  private armTimeout(id: string, command: Command, origin: ActionOrigin): void {
    this.confirm(id);
    const device = this.devices.get(id);
    const budget = command.kind === 'cover' ? ((device?.sim.travelSeconds ?? 22) + 8) * 1000 : 8_000;

    const timer = setTimeout(() => {
      this.pendingTimers.delete(id);
      this.attentes.delete(id);
      const current = this.states.get(id);
      if (!current?.pending) return;
      this.states.set(id, { ...current, pending: false, health: 'stale' });
      this.journaliser(id, command, origin, 'timeout');
      this.emit('state', this.states.get(id)!);
    }, budget);
    timer.unref?.();

    this.pendingTimers.set(id, timer);
    this.attentes.set(id, { command, origin });
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

  /** Historisation des mesures : échantillonnée, pas à chaque tick. */
  /**
   * Historise les mesures, au plus une par seconde ET PAR ÉQUIPEMENT.
   *
   * La limite était globale : le capteur le plus bavard raflait le quota et
   * les autres n'étaient presque jamais enregistrés. Mesuré sur un mois de
   * fonctionnement : 9 761 points pour la puissance, 358 pour toutes les
   * températures réunies. Un historique aussi troué rend l'intégration de
   * l'énergie fausse et les courbes de température illisibles.
   */
  private persistReadings(device: DeviceConfig, caps: Capability[]): void {
    const now = Date.now();
    // Les mesures SIMULÉES sont inventées : les écrire une fois par seconde
    // userait la carte du Pi pour remplir la base de nombres aléatoires. Une
    // par minute suffit à tester les écrans ; le vrai matériel garde 1 Hz.
    const simule = this.registry?.canalDe(device.id) === 'sim';
    if (now - (this.dernierEcrit.get(device.id) ?? 0) < (simule ? 60_000 : 1_000)) return;
    this.dernierEcrit.set(device.id, now);

    try {
      for (const cap of caps) {
        if (cap.kind === 'sensor') this.db.recordReading(device.id, cap.metric, cap.value);
        else if (cap.kind === 'climate') this.db.recordReading(device.id, 'temperature', cap.ambient);
      }
    } catch (e) {
      // Disque plein ou carte repassée en lecture seule : l'état en mémoire
      // reste juste, seule l'historisation s'arrête. On le dit, au plus une
      // fois par minute et par équipement.
      if (now - (this.dernierAvertissement.get(device.id) ?? 0) > 60_000) {
        this.dernierAvertissement.set(device.id, now);
        this.emit('warn', `[${device.id}] mesure non historisée : ${(e as Error).message}`);
      }
    }
  }

  private indexDevices(): void {
    this.devices.clear();
    for (const d of this.config.devices) this.devices.set(d.id, d);
  }
}

/**
 * La nouvelle du matériel correspond-elle à la commande envoyée ?
 *
 * C'est ce qui sépare « le module a répondu » de « le module a parlé ».
 * Tolérances volontaires : un variateur qui arrondit, un volet qui s'arrête
 * à 98 au lieu de 100, un thermostat au demi-degré.
 */
function correspond(caps: Capability[], command: Command): boolean {
  const cap = (kind: Capability['kind']) => caps.find((c) => c.kind === kind);
  switch (command.kind) {
    case 'switch': {
      const c = cap('switch');
      return c?.kind === 'switch' && c.state === command.state;
    }
    case 'dim': {
      const c = cap('dim');
      if (c?.kind === 'dim') return Math.abs(c.level - command.level) <= 2;
      // Un variateur sans retour de niveau : on se contente de l'interrupteur.
      const s = cap('switch');
      return s?.kind === 'switch' && s.state === command.level > 0;
    }
    case 'cover': {
      const c = cap('cover');
      return c?.kind === 'cover' && c.moving === null && Math.abs(c.position - command.position) <= 3;
    }
    case 'cover-stop': {
      const c = cap('cover');
      return c?.kind === 'cover' && c.moving === null;
    }
    case 'climate': {
      const c = cap('climate');
      return c?.kind === 'climate' && Math.abs(c.setpoint - command.setpoint) <= 0.5;
    }
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
