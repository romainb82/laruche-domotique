/**
 * Vocabulaire du domaine.
 *
 * Règle d'or : on ne modélise pas des produits, on modélise des capacités.
 * Rien ici ne connaît la marque d'un module. Le driver traduit ; le domaine ignore.
 */

/** Grandeurs mesurables. Fermé volontairement : on n'en ajoute pas à la légère. */
export type Metric =
  | 'temperature'
  | 'humidity'
  | 'lux'
  | 'ph'
  | 'orp'
  | 'power'
  | 'water_flow'
  | 'contact'
  | 'battery';

export const METRIC_UNITS: Record<Metric, string> = {
  temperature: '°C',
  humidity: '%',
  lux: 'lx',
  ph: '',
  orp: 'mV',
  power: 'W',
  water_flow: 'm³/h',
  contact: '',
  battery: '%',
};

export const METRIC_LABELS: Record<Metric, string> = {
  temperature: 'Température',
  humidity: 'Humidité',
  lux: 'Luminosité',
  ph: 'pH',
  orp: 'Potentiel redox',
  power: 'Puissance',
  water_flow: 'Débit',
  contact: 'Ouverture',
  battery: 'Batterie',
};

/** Ce qu'un équipement *est*, du point de vue de l'usage. */
export type DeviceType = 'light' | 'dimmer' | 'cover' | 'thermostat' | 'sensor';

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  light: 'Éclairage',
  dimmer: 'Éclairage variable',
  cover: 'Volet roulant',
  thermostat: 'Thermostat',
  sensor: 'Capteur',
};

/**
 * Fraîcheur de l'information.
 * Un capteur sur pile qui meurt ne renvoie pas d'erreur : il se tait.
 * Sans cette distinction, on régule sur un fantôme.
 */
export type Health = 'online' | 'stale' | 'offline';

/** L'état d'un équipement, exprimé en capacités. */
export type Capability =
  | { kind: 'switch'; state: boolean }
  | { kind: 'dim'; level: number } // 0–100
  | { kind: 'cover'; position: number; moving: 'up' | 'down' | null } // 0 fermé → 100 ouvert
  | { kind: 'climate'; setpoint: number; ambient: number; demand: boolean }
  | { kind: 'sensor'; metric: Metric; value: number; unit: string };

export type CapabilityKind = Capability['kind'];

/** Ce qu'on peut demander à un équipement. */
export type Command =
  | { kind: 'switch'; state: boolean }
  | { kind: 'dim'; level: number }
  | { kind: 'cover'; position: number }
  | { kind: 'cover-stop' }
  | { kind: 'climate'; setpoint: number };

/**
 * L'état diffusé aux interfaces.
 *
 * `pending` est le troisième état visuel : ni allumé ni éteint, « en cours ».
 * Il vaut true entre l'envoi d'une commande et sa confirmation par le matériel.
 * C'est ce qui empêche l'application de mentir.
 */
export interface DeviceState {
  id: string;
  caps: Capability[];
  health: Health;
  lastSeen: string; // ISO 8601
  pending: boolean;
}

/** Origine d'une action : indispensable pour déboguer une maison. */
export type ActionOrigin = 'ui' | 'schedule' | 'rule' | 'wall_switch' | 'system';

export interface ActionLogEntry {
  at: string;
  deviceId: string;
  command: Command;
  origin: ActionOrigin;
  outcome: 'confirmed' | 'timeout' | 'rejected';
}

// ---------------------------------------------------------------- utilitaires

/** Quelles capacités un type d'équipement expose-t-il ? */
export function capabilitiesFor(type: DeviceType): CapabilityKind[] {
  switch (type) {
    case 'light':
      return ['switch'];
    case 'dimmer':
      return ['switch', 'dim'];
    case 'cover':
      return ['cover'];
    case 'thermostat':
      return ['climate'];
    case 'sensor':
      return ['sensor'];
  }
}

export function findCap<K extends CapabilityKind>(
  state: DeviceState | undefined,
  kind: K,
): Extract<Capability, { kind: K }> | undefined {
  return state?.caps.find((c) => c.kind === kind) as
    | Extract<Capability, { kind: K }>
    | undefined;
}

/** Un équipement dont la mesure est périmée ne pilote jamais rien. */
export function isActionable(state: DeviceState | undefined): boolean {
  return !!state && state.health === 'online';
}
