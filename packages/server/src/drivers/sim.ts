import { METRIC_UNITS, type Capability, type Command, type DeviceConfig } from '@domo/shared';
import { initialCaps } from './driver.js';

type StateHandler = (deviceId: string, caps: Capability[]) => void;

/**
 * La maison virtuelle.
 *
 * Elle ne cherche pas à être juste physiquement — elle cherche à être
 * suffisamment désagréable pour que l'interface soit obligée d'être honnête :
 * un volet met vingt secondes à descendre, une pièce met des heures à chauffer,
 * et le pH d'un bassin monte tout seul.
 *
 * Ce driver ne disparaît pas à la mise en service. Il reste l'environnement de
 * test permanent : valider un scénario de chauffage sans attendre janvier,
 * déclencher une alarme de pH sans toucher au bassin.
 */
export class SimEngine {
  private handlers: StateHandler[] = [];
  private state = new Map<string, Capability[]>();
  private devices = new Map<string, DeviceConfig>();
  private covers = new Map<string, CoverMotion>();
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;

  constructor(
    private liste: DeviceConfig[],
    onState?: StateHandler,
  ) {
    if (onState) this.handlers.push(onState);
  }

  async start(): Promise<void> {
    for (const d of this.liste) {
      this.devices.set(d.id, d);
      this.state.set(d.id, initialCaps(d));
    }
    // Une première salve pour que l'interface ne s'ouvre jamais sur du vide.
    for (const [id, caps] of this.state) this.emit(id, caps);

    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Ne pas retenir le processus en vie pour un simulateur.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handlers = [];
    this.covers.clear();
  }

  onState(handler: StateHandler): void {
    this.handlers.push(handler);
  }

  async command(deviceId: string, command: Command): Promise<void> {
    const device = this.devices.get(deviceId);
    const caps = this.state.get(deviceId);
    if (!device || !caps) throw new Error(`Équipement inconnu : ${deviceId}`);

    // Un vrai module met quelques dizaines de millisecondes à répondre.
    // Reproduire ce délai force l'interface à gérer l'état « en cours ».
    await sleep(80 + Math.random() * 120);

    switch (command.kind) {
      case 'switch': {
        const next = caps.map((c) =>
          c.kind === 'switch'
            ? { ...c, state: command.state }
            : c.kind === 'dim'
              ? { ...c, level: command.state ? (c.level > 0 ? c.level : 100) : 0 }
              : c,
        );
        this.commit(deviceId, next);
        break;
      }
      case 'dim': {
        const level = clamp(command.level, 0, 100);
        const next = caps.map((c) =>
          c.kind === 'dim'
            ? { ...c, level }
            : c.kind === 'switch'
              ? { ...c, state: level > 0 }
              : c,
        );
        this.commit(deviceId, next);
        break;
      }
      case 'cover': {
        const cur = caps.find((c) => c.kind === 'cover');
        if (cur?.kind !== 'cover') break;
        const target = clamp(command.position, 0, 100);
        const travel = device.sim.travelSeconds ?? 22;
        if (Math.abs(target - cur.position) < 0.5) {
          this.commit(deviceId, [{ kind: 'cover', position: target, moving: null }]);
          break;
        }
        this.covers.set(deviceId, {
          target,
          // % de course par tick, dérivé de la durée de course complète
          speed: (100 / travel) * (TICK_MS / 1000),
        });
        this.commit(deviceId, [
          { kind: 'cover', position: cur.position, moving: target > cur.position ? 'up' : 'down' },
        ]);
        break;
      }
      case 'cover-stop': {
        this.covers.delete(deviceId);
        const cur = caps.find((c) => c.kind === 'cover');
        if (cur?.kind === 'cover')
          this.commit(deviceId, [{ kind: 'cover', position: cur.position, moving: null }]);
        break;
      }
      case 'climate': {
        const next = caps.map((c) =>
          c.kind === 'climate'
            ? { ...c, setpoint: clamp(command.setpoint, 5, 30) }
            : c,
        );
        this.commit(deviceId, next);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ moteur

  private tick(): void {
    this.tickCount++;
    this.stepCovers();
    // Les capteurs bougent lentement : inutile de les recalculer 5 fois par seconde.
    if (this.tickCount % SENSOR_EVERY === 0) {
      this.stepSensors();
      this.stepClimate();
    }
    if (this.tickCount % HEARTBEAT_EVERY === 0) this.heartbeat();
  }

  /**
   * Un module réel republie son état régulièrement, même quand rien ne change.
   * Sans ce battement, une lampe qu'on n'a pas touchée depuis cinq minutes
   * serait déclarée « ne répond plus » — et l'application crierait au loup.
   */
  private heartbeat(): void {
    for (const [id, caps] of this.state) {
      // Les capteurs et les volets en mouvement parlent déjà d'eux-mêmes.
      if (this.covers.has(id)) continue;
      const device = this.devices.get(id);
      if (device?.type === 'sensor' || device?.type === 'thermostat') continue;
      this.emit(id, caps);
    }
  }

  private stepCovers(): void {
    for (const [id, motion] of this.covers) {
      const caps = this.state.get(id);
      const cur = caps?.find((c) => c.kind === 'cover');
      if (cur?.kind !== 'cover') {
        this.covers.delete(id);
        continue;
      }
      const dir = motion.target > cur.position ? 1 : -1;
      let position = cur.position + dir * motion.speed;
      let moving: 'up' | 'down' | null = dir > 0 ? 'up' : 'down';

      const arrived = dir > 0 ? position >= motion.target : position <= motion.target;
      if (arrived) {
        position = motion.target;
        moving = null;
        this.covers.delete(id);
      }
      this.commit(id, [{ kind: 'cover', position: round(position, 1), moving }]);
    }
  }

  private stepSensors(): void {
    const hours = (this.tickCount * TICK_MS) / 3_600_000;
    for (const device of this.liste) {
      if (device.type !== 'sensor') continue;
      const caps = this.state.get(device.id);
      const cur = caps?.find((c) => c.kind === 'sensor');
      if (cur?.kind !== 'sensor') continue;

      const metric = cur.metric;
      const unit = METRIC_UNITS[metric];

      if (metric === 'contact') {
        // Les ouvertures sont rares : on ne fabrique pas de faux mouvement.
        this.commit(device.id, [{ ...cur, unit }]);
        continue;
      }

      const base = device.sim.base ?? cur.value;
      const noise = device.sim.noise ?? 0;
      const drift = (device.sim.driftPerHour ?? 0) * hours;

      let value = base + drift + (Math.random() - 0.5) * 2 * noise;

      // La luminosité suit une journée : c'est ce qui rendra testables les
      // automatismes de crépuscule sans attendre le soir.
      if (metric === 'lux') value = Math.max(0, value * dayCycle());

      const decimals = metric === 'ph' ? 2 : metric === 'power' || metric === 'lux' || metric === 'orp' ? 0 : 1;
      this.commit(device.id, [{ ...cur, value: round(value, decimals), unit }]);
    }
  }

  /**
   * Inertie thermique. Une dalle ou un volume d'air ne suit pas la consigne :
   * il s'en approche lentement, et dépasse quand on coupe trop tard.
   */
  private stepClimate(): void {
    for (const device of this.liste) {
      if (device.type !== 'thermostat') continue;
      const caps = this.state.get(device.id);
      const cur = caps?.find((c) => c.kind === 'climate');
      if (cur?.kind !== 'climate') continue;

      const gap = cur.setpoint - cur.ambient;
      const demand = gap > 0.3;
      // Volontairement lent : c'est le point du simulateur.
      const rate = device.sim.inertie ?? 0.02;
      const ambient = cur.ambient + (demand ? rate : gap < -0.3 ? -rate / 2 : 0);

      this.commit(device.id, [
        { kind: 'climate', setpoint: cur.setpoint, ambient: round(ambient, 2), demand },
      ]);
    }
  }

  private commit(deviceId: string, caps: Capability[]): void {
    this.state.set(deviceId, caps);
    this.emit(deviceId, caps);
  }

  private emit(deviceId: string, caps: Capability[]): void {
    for (const h of this.handlers) h(deviceId, caps);
  }
}

interface CoverMotion {
  target: number;
  speed: number;
}

const TICK_MS = 250;
const SENSOR_EVERY = 20; // → toutes les 5 s
const HEARTBEAT_EVERY = 120; // → toutes les 30 s, bien sous le délai de péremption

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 0 la nuit, 1 en plein jour. */
function dayCycle(): number {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
}
