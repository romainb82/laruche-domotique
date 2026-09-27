import type { CapabilityKind, Command } from './types.js';

/**
 * Le raccordement — le cerveau de la connectivité.
 *
 * Objectif : pouvoir brancher n'importe quel matériel sans écrire une ligne de
 * code. Pour ça, trois notions suffisent :
 *
 *   1. une CONNEXION  — un canal vers le monde extérieur (un broker MQTT, une
 *                       API HTTP, le simulateur…) ;
 *   2. une LECTURE    — d'où vient une valeur, et dans quelle case du modèle
 *                       elle atterrit ;
 *   3. une ÉCRITURE   — où envoyer une commande, et sous quelle forme.
 *
 * Tout le reste — marques, protocoles, formats de charge utile — se règle avec
 * des transformations déclaratives. Aucun `eval`, aucun code utilisateur.
 */

// ------------------------------------------------------------------ connexions

export type ConnectionKind = 'sim' | 'mqtt' | 'http' | 'modbus';

export const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  sim: 'Simulateur',
  mqtt: 'Broker MQTT',
  http: 'API HTTP',
  modbus: 'Modbus TCP',
};

export interface MqttConnectionSettings {
  url: string;
  username: string;
  password: string;
  /** Préfixe commun. Sert aussi de racine à la découverte. */
  baseTopic: string;
}

export interface HttpConnectionSettings {
  baseUrl: string;
  /** En-têtes ajoutés à chaque requête (jeton d'API, etc.). */
  headers: Record<string, string>;
  /** Intervalle d'interrogation, en secondes. */
  pollSeconds: number;
}

/**
 * Modbus TCP — le protocole du matériel technique.
 *
 * Pompes à chaleur, centrales de traitement d'air, compteurs d'énergie,
 * onduleurs : ce monde-là ne parle ni MQTT ni JSON. Il expose des registres
 * numérotés, et rien d'autre. Pas de découverte possible : aucun équipement
 * Modbus ne sait dire ce qu'il contient — c'est la documentation du fabricant
 * qui fait foi. En revanche on peut LIRE une plage et montrer ce qui s'y
 * trouve, ce qui revient presque au même à l'usage.
 *
 * La liaison série (RTU, sur RS-485) n'est pas couverte : elle demande un
 * pilote natif et un adaptateur USB. Le jour où ce sera nécessaire, la même
 * grammaire d'adresse s'y appliquera sans rien changer aux raccordements.
 */
export interface ModbusConnectionSettings {
  host: string;
  port: number;
  /** Identifiant d'esclave. Souvent 1, parfois 255 sur une passerelle. */
  unitId: number;
  /** Intervalle d'interrogation, en secondes. */
  pollSeconds: number;

  /**
   * Le balayage, qui tient lieu de découverte.
   *
   * `scanCount` à zéro l'éteint, et c'est le défaut : lire une plage de
   * registres chez un équipement qu'on ne connaît pas est une impolitesse
   * qu'on ne s'autorise pas sans qu'elle ait été demandée.
   */
  scanTable: ModbusTable;
  scanFrom: number;
  scanCount: number;
}

export interface Connection {
  id: string;
  kind: ConnectionKind;
  label: string;
  enabled: boolean;
  settings: Partial<MqttConnectionSettings & HttpConnectionSettings & ModbusConnectionSettings>;
}

/** État vivant d'une connexion, remonté à l'interface. */
export interface ConnectionStatus {
  id: string;
  kind: ConnectionKind;
  label: string;
  state: 'connected' | 'connecting' | 'error' | 'disabled';
  /** Message d'erreur lisible, jamais une trace technique brute. */
  detail: string | null;
  devices: number;
  lastEvent: string | null;
}

// --------------------------------------------------------------- destinations

/**
 * La case du modèle qu'une lecture alimente.
 *
 * C'est la pièce maîtresse : elle permet de câbler n'importe quelle source sur
 * n'importe quelle information, sans que le domaine ait à connaître le matériel.
 */
export type CapField =
  | 'switch.state'
  | 'dim.level'
  | 'cover.position'
  | 'cover.moving'
  | 'climate.setpoint'
  | 'climate.ambient'
  | 'climate.demand'
  | 'sensor.value';

export const CAP_FIELD_LABELS: Record<CapField, string> = {
  'switch.state': 'Allumé / éteint',
  'dim.level': "Niveau d'intensité",
  'cover.position': 'Position du volet',
  'cover.moving': 'Volet en mouvement',
  'climate.setpoint': 'Consigne',
  'climate.ambient': 'Température mesurée',
  'climate.demand': 'Demande de chauffe',
  'sensor.value': 'Valeur mesurée',
};

/** Quelles cases ont un sens pour une capacité donnée. */
export const FIELDS_BY_CAPABILITY: Record<CapabilityKind, CapField[]> = {
  switch: ['switch.state'],
  dim: ['dim.level'],
  cover: ['cover.position', 'cover.moving'],
  climate: ['climate.setpoint', 'climate.ambient', 'climate.demand'],
  sensor: ['sensor.value'],
};

// ----------------------------------------------------------- transformations

/**
 * Chaîne de transformation, appliquée dans l'ordre.
 *
 * Volontairement fermée et sans expression arbitraire : un fichier de
 * configuration ne doit jamais pouvoir exécuter du code. Ces quelques
 * opérations couvrent l'immense majorité du matériel réel.
 */
export type Transform =
  | { op: 'number' }
  | { op: 'bool'; truthy: string[] }
  | { op: 'scale'; factor: number; offset: number }
  | { op: 'round'; decimals: number }
  | { op: 'clamp'; min: number; max: number }
  /** 0–100 → 100–0. Certains volets comptent la fermeture, pas l'ouverture. */
  | { op: 'invert'; span: number }
  /** Table de correspondance : 'ouverture' → 'up', '1' → true… */
  | { op: 'map'; table: Record<string, string | number | boolean> };

export type TransformOp = Transform['op'];

export const TRANSFORM_LABELS: Record<TransformOp, string> = {
  number: 'Convertir en nombre',
  bool: 'Convertir en oui / non',
  scale: 'Mettre à l’échelle',
  round: 'Arrondir',
  clamp: 'Borner',
  invert: 'Inverser le sens',
  map: 'Table de correspondance',
};

// ------------------------------------------------------- lectures / écritures

export interface ReadSpec {
  /**
   * Topic MQTT, chemin relatif à la base HTTP, ou adresse Modbus.
   * Voir {@link MODBUS_ADDRESS_HINT} pour la grammaire des adresses.
   */
  source: string;
  /** Chemin dans la charge utile JSON. Vide = la charge utile entière. */
  path: string;
  /** Où atterrit la valeur. */
  into: CapField;
  pipeline: Transform[];
}

export type CommandKind = Command['kind'];

export interface WriteSpec {
  /** Quelle commande déclenche cette écriture. */
  on: CommandKind;
  /** Topic MQTT, chemin relatif HTTP, ou adresse Modbus. */
  target: string;
  /**
   * Gabarit de la charge utile. `{{valeur}}` est remplacé par la valeur
   * transformée. Exemples : `on`, `{{valeur}}`, `{"pos":{{valeur}}}`.
   */
  payload: string;
  /** Appliqué à la valeur AVANT substitution dans le gabarit. */
  pipeline: Transform[];
  /** HTTP uniquement. */
  method: 'GET' | 'POST' | 'PUT';
}

export interface Binding {
  connectionId: string;
  reads: ReadSpec[];
  writes: WriteSpec[];
}

// ------------------------------------------------------------------ découverte

/**
 * Un équipement aperçu sur le réseau mais pas encore adopté.
 *
 * Le principe : on n'oblige jamais à deviner un topic. On écoute, on liste ce
 * qui parle, et on propose de l'adopter en un geste.
 */
export interface Candidate {
  /** Identifiant stable, pour ne pas proposer deux fois la même chose. */
  key: string;
  connectionId: string;
  /** Ce qu'on a vu : topic MQTT, point d'entrée HTTP… */
  source: string;
  /** Dernière charge utile observée, tronquée. */
  sample: string;
  /** Chemins JSON détectés dans la charge utile, avec un exemple de valeur. */
  paths: { path: string; sample: string }[];
  firstSeen: string;
  lastSeen: string;
  count: number;
}

// --------------------------------------------------------- adresses Modbus

/**
 * Les quatre tables de registres du protocole.
 *
 * `coil` et `discrete` portent des bits, `holding` et `input` des mots de
 * 16 bits. Les deux premières de chaque paire s'écrivent, les autres se
 * lisent seulement — c'est le protocole qui en décide, pas nous.
 */
export type ModbusTable = 'coil' | 'discrete' | 'holding' | 'input';

export const MODBUS_TABLE_LABELS: Record<ModbusTable, string> = {
  coil: 'Bobine (bit, lecture et écriture)',
  discrete: 'Entrée TOR (bit, lecture seule)',
  holding: 'Registre de maintien (mot, lecture et écriture)',
  input: "Registre d'entrée (mot, lecture seule)",
};

/**
 * Comment lire une suite de mots.
 *
 * `-swap` inverse l'ordre des deux mots d'une valeur 32 bits. Ce n'est pas une
 * coquetterie : la moitié du matériel place le mot de poids fort en premier,
 * l'autre moitié en second, et la documentation l'oublie une fois sur deux.
 */
export type ModbusType =
  | 'uint16' | 'int16'
  | 'uint32' | 'int32' | 'float32'
  | 'uint32-swap' | 'int32-swap' | 'float32-swap';

export const MODBUS_TYPE_LABELS: Record<ModbusType, string> = {
  uint16: 'Entier 16 bits non signé',
  int16: 'Entier 16 bits signé',
  uint32: 'Entier 32 bits non signé',
  int32: 'Entier 32 bits signé',
  float32: 'Flottant 32 bits',
  'uint32-swap': 'Entier 32 bits non signé, mots inversés',
  'int32-swap': 'Entier 32 bits signé, mots inversés',
  'float32-swap': 'Flottant 32 bits, mots inversés',
};

/** Combien de registres occupe une valeur de ce type. */
export function modbusWords(type: ModbusType): number {
  return type === 'uint16' || type === 'int16' ? 1 : 2;
}

export interface ModbusAddress {
  table: ModbusTable;
  /** Décalage brut, à partir de 0. */
  offset: number;
  type: ModbusType;
}

export const MODBUS_ADDRESS_HINT =
  'Forme : table:adresse[:type] — par exemple holding:100, coil:5, ' +
  'input:12:float32. L’adresse est brute et commence à 0 : un document qui ' +
  'annonce 40101 en notation Modicon désigne holding:100 ici.';

/**
 * Analyse une adresse écrite à la main.
 *
 * Rend un message en français plutôt qu'un `null` muet : une adresse Modbus
 * mal tapée ne se voit pas à l'œil, et l'équipement ne dira jamais qu'on lui
 * parle du mauvais registre — il répondra une valeur, fausse.
 */
export function parseModbusAddress(
  source: string,
): { ok: true; address: ModbusAddress } | { ok: false; error: string } {
  const morceaux = source.trim().split(':');
  if (morceaux.length < 2 || morceaux.length > 3)
    return { ok: false, error: `« ${source} » n’est pas une adresse Modbus. ${MODBUS_ADDRESS_HINT}` };

  const [tableBrute, offsetBrut, typeBrut] = morceaux;
  const table = tableBrute!.toLowerCase() as ModbusTable;
  if (!(table in MODBUS_TABLE_LABELS))
    return {
      ok: false,
      error: `Table « ${tableBrute} » inconnue. Attendu : ${Object.keys(MODBUS_TABLE_LABELS).join(', ')}.`,
    };

  const offset = Number(offsetBrut);
  if (!Number.isInteger(offset) || offset < 0 || offset > 65535)
    return { ok: false, error: `Adresse « ${offsetBrut} » hors plage : attendu un entier de 0 à 65535.` };

  const bit = table === 'coil' || table === 'discrete';
  if (typeBrut && bit)
    return { ok: false, error: `Une ${table === 'coil' ? 'bobine' : 'entrée TOR'} porte un bit : elle n’a pas de type.` };

  const type = (typeBrut ?? 'uint16').toLowerCase() as ModbusType;
  if (!bit && !(type in MODBUS_TYPE_LABELS))
    return {
      ok: false,
      error: `Type « ${typeBrut} » inconnu. Attendu : ${Object.keys(MODBUS_TYPE_LABELS).join(', ')}.`,
    };

  return { ok: true, address: { table, offset, type: bit ? 'uint16' : type } };
}

/** Écrit une adresse sous sa forme canonique. */
export function formatModbusAddress(a: ModbusAddress): string {
  const bit = a.table === 'coil' || a.table === 'discrete';
  return bit ? `${a.table}:${a.offset}` : `${a.table}:${a.offset}:${a.type}`;
}
