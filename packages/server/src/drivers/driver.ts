import type { Capability, DeviceConfig } from '@domo/shared';

/**
 * État de départ plausible pour un équipement.
 *
 * Sert au simulateur comme aux adaptateurs réels : tant qu'un module n'a rien
 * publié, on affiche une valeur cohérente plutôt qu'un écran vide — mais
 * l'équipement reste marqué hors ligne, donc l'interface ne ment pas.
 */
export function initialCaps(device: DeviceConfig): Capability[] {
  switch (device.type) {
    case 'light':
      return [{ kind: 'switch', state: false }];
    case 'dimmer':
      return [
        { kind: 'switch', state: false },
        { kind: 'dim', level: 0 },
      ];
    case 'cover':
      return [{ kind: 'cover', position: 100, moving: null }];
    case 'thermostat':
      return [{ kind: 'climate', setpoint: 20, ambient: 19.5, demand: false }];
    case 'sensor': {
      const metric = device.metric ?? 'temperature';
      return [{ kind: 'sensor', metric, value: device.sim.base ?? 0, unit: '' }];
    }
  }
}
