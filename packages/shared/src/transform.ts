import type { Transform } from './wiring.js';

/**
 * Le traducteur.
 *
 * Entre ce qu'un module publie (`{"params":{"switch:0":{"output":true}}}`,
 * `ON`, `0..255`, `"ouverture"`) et ce que le domaine attend (un booléen, un
 * pourcentage, `'up' | 'down' | null`), il y a toujours une petite traduction.
 * La faire ici, de façon déclarative, évite d'écrire un driver par marque.
 *
 * Tout est pur et sans effet de bord : aucune expression n'est évaluée, donc un
 * fichier de configuration ne peut jamais exécuter de code.
 */

/**
 * Suit un chemin dans une charge utile.
 *
 * Accepte le JSON comme le texte nu, parce que le matériel réel fait les deux :
 * Shelly publie du JSON, un vieux module publie `ON`.
 * Les segments peuvent contenir des points s'ils sont entre crochets —
 * `params['switch:0'].output` — cas fréquent chez Shelly.
 */
export function readPath(raw: string, path: string): unknown {
  let node: unknown;
  try {
    node = JSON.parse(raw);
  } catch {
    // Charge utile non-JSON : seul le chemin vide a du sens.
    return path ? undefined : raw;
  }
  if (!path) return node;

  for (const key of splitPath(path)) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      node = node[index];
    } else if (typeof node === 'object') {
      node = (node as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** `params['switch:0'].output` → ['params', 'switch:0', 'output'] */
export function splitPath(path: string): string[] {
  const out: string[] = [];
  const re = /\['([^']*)'\]|\["([^"]*)"\]|\[(\d+)\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const DEFAUT_VRAI = ['true', 'on', '1', 'yes', 'open', 'ouvert'];

/** Applique la chaîne de transformations, dans l'ordre. */
export function applyPipeline(value: unknown, pipeline: Transform[]): unknown {
  let v = value;
  for (const step of pipeline) v = applyOne(v, step);
  return v;
}

function applyOne(v: unknown, step: Transform): unknown {
  switch (step.op) {
    case 'number': {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const s = String(v).trim().toLowerCase();
      const vrais = step.truthy.length ? step.truthy : DEFAUT_VRAI;
      return vrais.some((t) => t.toLowerCase() === s);
    }
    case 'scale': {
      const n = Number(v);
      return Number.isFinite(n) ? n * step.factor + step.offset : undefined;
    }
    case 'round': {
      const n = Number(v);
      if (!Number.isFinite(n)) return undefined;
      const f = 10 ** step.decimals;
      return Math.round(n * f) / f;
    }
    case 'clamp': {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(step.max, Math.max(step.min, n)) : undefined;
    }
    case 'invert': {
      const n = Number(v);
      return Number.isFinite(n) ? step.span - n : undefined;
    }
    case 'map': {
      // La clé est cherchée telle quelle, puis en minuscules : un module qui
      // publie « OUVERTURE » et une table écrite en « ouverture » doivent
      // se rencontrer sans que personne n'ait à y penser.
      const brut = String(v);
      if (Object.hasOwn(step.table, brut)) return step.table[brut];
      const bas = brut.toLowerCase();
      for (const [k, out] of Object.entries(step.table)) {
        if (k.toLowerCase() === bas) return out;
      }
      return undefined;
    }
  }
}

/**
 * Substitue la valeur dans le gabarit de charge utile.
 *
 * `{{valeur}}` accepte aussi `{{value}}` — on écrit du français ici, mais la
 * documentation du matériel est en anglais et on ne va pas piéger l'utilisateur
 * sur ce détail.
 */
export function renderPayload(template: string, value: unknown): string {
  if (!template) return String(value ?? '');
  const rendu = String(value ?? '');
  return template.replace(/\{\{\s*(valeur|value)\s*\}\}/gi, rendu);
}

/**
 * Décompose une charge utile en chemins exploitables, avec un échantillon.
 * Sert la découverte : on montre à l'utilisateur ce qu'il peut brancher, plutôt
 * que de lui demander de deviner un chemin JSON.
 */
export function inspectPayload(raw: string, max = 40): { path: string; sample: string }[] {
  let node: unknown;
  try {
    node = JSON.parse(raw);
  } catch {
    return [{ path: '', sample: tronquer(raw) }];
  }
  if (node === null || typeof node !== 'object') {
    return [{ path: '', sample: tronquer(String(node)) }];
  }

  const out: { path: string; sample: string }[] = [];
  const marcher = (n: unknown, prefixe: string) => {
    if (out.length >= max) return;
    if (n !== null && typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        // Une clé contenant un point ou deux-points doit être échappée,
        // sinon on ne saura pas la relire (cas 'switch:0' chez Shelly).
        const segment = /[.[\]]/.test(k) ? `['${k}']` : k;
        marcher(v, prefixe ? `${prefixe}.${segment}` : segment);
      }
      return;
    }
    out.push({ path: prefixe, sample: tronquer(String(n)) });
  };
  marcher(node, '');
  return out;
}

function tronquer(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// --------------------------------------------------------------- pré-réglages

/**
 * Raccordements tout faits pour le matériel courant.
 *
 * Ce n'est pas du code spécifique à une marque : ce sont des valeurs par défaut
 * que l'interface proposera, et que l'utilisateur peut modifier entièrement.
 * Ajouter une marque revient à ajouter une entrée dans cette liste — jamais à
 * toucher au moteur.
 */
export interface Preset {
  id: string;
  label: string;
  hint: string;
  kind: 'mqtt' | 'http' | 'modbus';
  reads: { source: string; path: string; into: string; pipeline: Transform[] }[];
  writes: { on: string; target: string; payload: string; pipeline: Transform[] }[];
}

export const PRESETS: Preset[] = [
  {
    id: 'shelly-relais',
    label: 'Shelly — relais (Gen 2/3)',
    hint: 'Module encastré derrière un interrupteur. `{id}` sera remplacé par l’identifiant du module.',
    kind: 'mqtt',
    reads: [
      { source: '{id}/status/switch:0', path: 'output', into: 'switch.state', pipeline: [{ op: 'bool', truthy: [] }] },
    ],
    writes: [
      { on: 'switch', target: '{id}/rpc', payload: '{"id":1,"method":"Switch.Set","params":{"id":0,"on":{{valeur}}}}', pipeline: [{ op: 'bool', truthy: [] }] },
    ],
  },
  {
    id: 'shelly-volet',
    label: 'Shelly — volet roulant',
    hint: 'Le module publie la position en pourcentage d’ouverture.',
    kind: 'mqtt',
    reads: [
      { source: '{id}/status/cover:0', path: 'current_pos', into: 'cover.position', pipeline: [{ op: 'number' }, { op: 'clamp', min: 0, max: 100 }] },
      { source: '{id}/status/cover:0', path: 'state', into: 'cover.moving', pipeline: [{ op: 'map', table: { opening: 'up', closing: 'down', open: '', closed: '', stopped: '' } }] },
    ],
    writes: [
      { on: 'cover', target: '{id}/rpc', payload: '{"id":1,"method":"Cover.GoToPosition","params":{"id":0,"pos":{{valeur}}}}', pipeline: [{ op: 'round', decimals: 0 }] },
      { on: 'cover-stop', target: '{id}/rpc', payload: '{"id":1,"method":"Cover.Stop","params":{"id":0}}', pipeline: [] },
    ],
  },
  {
    id: 'z2m-interrupteur',
    label: 'Zigbee2MQTT — interrupteur',
    hint: 'Topic de la forme `zigbee2mqtt/<nom du module>`.',
    kind: 'mqtt',
    reads: [
      { source: '{id}', path: 'state', into: 'switch.state', pipeline: [{ op: 'bool', truthy: ['ON'] }] },
    ],
    writes: [
      { on: 'switch', target: '{id}/set', payload: '{"state":"{{valeur}}"}', pipeline: [{ op: 'map', table: { true: 'ON', false: 'OFF' } }] },
    ],
  },
  {
    id: 'z2m-capteur',
    label: 'Zigbee2MQTT — capteur de température',
    hint: 'Un seul topic porte température, humidité et batterie.',
    kind: 'mqtt',
    reads: [
      { source: '{id}', path: 'temperature', into: 'sensor.value', pipeline: [{ op: 'number' }, { op: 'round', decimals: 1 }] },
    ],
    writes: [],
  },
  {
    id: 'z2m-volet',
    label: 'Zigbee2MQTT — volet roulant',
    hint: 'Attention : beaucoup de volets Zigbee comptent la FERMETURE. L’inversion est déjà en place.',
    kind: 'mqtt',
    reads: [
      { source: '{id}', path: 'position', into: 'cover.position', pipeline: [{ op: 'number' }, { op: 'invert', span: 100 }, { op: 'clamp', min: 0, max: 100 }] },
    ],
    writes: [
      { on: 'cover', target: '{id}/set', payload: '{"position":{{valeur}}}', pipeline: [{ op: 'invert', span: 100 }, { op: 'round', decimals: 0 }] },
      { on: 'cover-stop', target: '{id}/set', payload: '{"state":"STOP"}', pipeline: [] },
    ],
  },
  {
    id: 'mqtt-brut',
    label: 'MQTT générique',
    hint: 'Deux topics, du texte nu. Le plus simple qui puisse marcher.',
    kind: 'mqtt',
    reads: [
      { source: '{id}/state', path: '', into: 'switch.state', pipeline: [{ op: 'bool', truthy: [] }] },
    ],
    writes: [
      { on: 'switch', target: '{id}/set', payload: '{{valeur}}', pipeline: [{ op: 'map', table: { true: 'on', false: 'off' } }] },
    ],
  },
  {
    id: 'http-json',
    label: 'API HTTP — mesure JSON',
    hint: 'Interrogé à intervalle régulier. Idéal pour un régulateur de piscine ou une passerelle.',
    kind: 'http',
    reads: [
      { source: '/status', path: 'value', into: 'sensor.value', pipeline: [{ op: 'number' }, { op: 'round', decimals: 2 }] },
    ],
    writes: [],
  },
  {
    id: 'modbus-temperature',
    label: 'Modbus — température au dixième',
    hint:
      'Le cas le plus courant du matériel technique : un entier signé qui vaut ' +
      'dix fois la température. `holding:100` se lit « registre de maintien, ' +
      'adresse 100 » — l’adresse commence à 0, pas à 40001.',
    kind: 'modbus',
    reads: [
      { source: 'holding:100:int16', path: '', into: 'sensor.value', pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] },
    ],
    writes: [],
  },
  {
    id: 'modbus-consigne',
    label: 'Modbus — consigne de chauffage',
    hint:
      'Lecture de la consigne et de la température ambiante, écriture de la ' +
      'consigne. Les trois adresses sont à relever dans la documentation du ' +
      'fabricant : rien ne permet de les deviner.',
    kind: 'modbus',
    reads: [
      { source: 'holding:200:int16', path: '', into: 'climate.setpoint', pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] },
      { source: 'holding:201:int16', path: '', into: 'climate.ambient', pipeline: [{ op: 'scale', factor: 0.1, offset: 0 }, { op: 'round', decimals: 1 }] },
      { source: 'discrete:10', path: '', into: 'climate.demand', pipeline: [] },
    ],
    writes: [
      { on: 'climate', target: 'holding:200', payload: '{{valeur}}', pipeline: [{ op: 'scale', factor: 10, offset: 0 }, { op: 'round', decimals: 0 }] },
    ],
  },
  {
    id: 'modbus-relais',
    label: 'Modbus — relais tout ou rien',
    hint: 'Une bobine se lit et s’écrit. Une entrée TOR (`discrete:`) se lit seulement.',
    kind: 'modbus',
    reads: [
      { source: 'coil:0', path: '', into: 'switch.state', pipeline: [] },
    ],
    writes: [
      { on: 'switch', target: 'coil:0', payload: '{{valeur}}', pipeline: [] },
    ],
  },
  {
    id: 'modbus-compteur',
    label: 'Modbus — compteur d’énergie (flottant 32 bits)',
    hint:
      'Une valeur 32 bits occupe DEUX registres. Si la lecture donne un nombre ' +
      'absurde, essaie `float32-swap` : la moitié du matériel inverse les deux ' +
      'mots, et la documentation l’oublie une fois sur deux.',
    kind: 'modbus',
    reads: [
      { source: 'input:300:float32', path: '', into: 'sensor.value', pipeline: [{ op: 'round', decimals: 1 }] },
    ],
    writes: [],
  },
];
