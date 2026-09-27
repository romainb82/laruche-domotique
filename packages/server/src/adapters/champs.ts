import { capabilitiesFor, METRIC_UNITS, type Capability, type CapField, type DeviceConfig } from '@domo/shared';

/**
 * Pose une valeur venue du matériel dans la bonne case du modèle.
 *
 * C'est le point de rencontre entre « ce qu'un module raconte » et « ce que le
 * domaine sait manipuler ». Tout passe par ici, quel que soit le protocole :
 * MQTT, HTTP, ou le simulateur.
 */
export function poser(
  caps: Capability[],
  device: DeviceConfig,
  champ: CapField,
  valeur: unknown,
): Capability[] {
  const [genre] = champ.split('.') as [Capability['kind']];
  // Un champ qui n'a pas de sens pour ce type d'equipement est ignore
  // silencieusement : mieux vaut une lecture perdue qu'un etat incoherent.
  if (!capabilitiesFor(device.type).includes(genre)) return caps;

  const sortie = [...caps];
  const i = sortie.findIndex((c) => c.kind === genre);
  const courant = i >= 0 ? sortie[i]! : vide(genre, device);
  const suivant = fusionner(courant, champ, valeur, device);
  if (!suivant) return caps;

  if (i >= 0) sortie[i] = suivant;
  else sortie.push(suivant);
  return sortie;
}

function fusionner(
  cap: Capability,
  champ: CapField,
  v: unknown,
  device: DeviceConfig,
): Capability | null {
  switch (champ) {
    case 'switch.state':
      return cap.kind === 'switch' ? { ...cap, state: Boolean(v) } : null;
    case 'dim.level':
      return cap.kind === 'dim' && estNombre(v) ? { ...cap, level: borne(Number(v), 0, 100) } : null;
    case 'cover.position':
      return cap.kind === 'cover' && estNombre(v)
        ? { ...cap, position: borne(Number(v), 0, 100) }
        : null;
    case 'cover.moving': {
      if (cap.kind !== 'cover') return null;
      const s = String(v ?? '').toLowerCase();
      const moving = s === 'up' || s === 'down' ? (s as 'up' | 'down') : null;
      return { ...cap, moving };
    }
    case 'climate.setpoint':
      return cap.kind === 'climate' && estNombre(v) ? { ...cap, setpoint: Number(v) } : null;
    case 'climate.ambient':
      return cap.kind === 'climate' && estNombre(v) ? { ...cap, ambient: Number(v) } : null;
    case 'climate.demand':
      return cap.kind === 'climate' ? { ...cap, demand: Boolean(v) } : null;
    case 'sensor.value': {
      if (cap.kind !== 'sensor') return null;
      const metric = device.metric ?? cap.metric;
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      if (!Number.isFinite(n)) return null;
      return { ...cap, metric, value: n, unit: METRIC_UNITS[metric] };
    }
  }
}

function vide(genre: Capability['kind'], device: DeviceConfig): Capability {
  switch (genre) {
    case 'switch': return { kind: 'switch', state: false };
    case 'dim': return { kind: 'dim', level: 0 };
    case 'cover': return { kind: 'cover', position: 0, moving: null };
    case 'climate': return { kind: 'climate', setpoint: 20, ambient: 20, demand: false };
    case 'sensor': {
      const metric = device.metric ?? 'temperature';
      return { kind: 'sensor', metric, value: 0, unit: METRIC_UNITS[metric] };
    }
  }
}

const estNombre = (v: unknown) => Number.isFinite(typeof v === 'boolean' ? NaN : Number(v));
const borne = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
