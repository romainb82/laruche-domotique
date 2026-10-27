import type { Command, DeviceConfig } from '@domo/shared';
import { BaseAdapter, type AdapterContext } from './adapter.js';
import { SimEngine } from '../drivers/sim.js';

/**
 * Le simulateur, en adaptateur.
 *
 * Il ne disparaît jamais : il sert TOUS les équipements qui n'ont pas encore de
 * raccordement. C'est ce qui permet d'équiper la maison pièce par pièce : une
 * chambre en vrai, le reste en simulé, sans que l'application fasse la
 * différence.
 */
export class SimAdapter extends BaseAdapter {
  private engine: SimEngine | null = null;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  async start(): Promise<void> {
    this.engine = new SimEngine([...this.devices.values()], (deviceId, caps) =>
      this.ctx.emit({ deviceId, caps }),
    );
    await this.engine.start();
    this.marquer('connected');
  }

  async stop(): Promise<void> {
    await this.engine?.stop();
    this.engine = null;
    this.marquer('disabled');
  }

  async attach(devices: DeviceConfig[]): Promise<void> {
    await super.attach(devices);
    if (this.engine) {
      await this.engine.stop();
      await this.start();
    }
  }

  async command(device: DeviceConfig, command: Command): Promise<void> {
    if (!this.engine) throw new Error('Simulateur à l’arrêt.');
    await this.engine.command(device.id, command);
  }
}
