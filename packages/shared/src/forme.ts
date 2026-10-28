/**
 * La FORME d'une configuration : ce que les types TypeScript promettent et que
 * le réseau ne garantit pas.
 *
 * `validateConfig` vérifie la cohérence métier (zones fantômes, identifiants
 * en double) en supposant la forme bonne. Mais une requête HTTP n'a pas de
 * types : un champ absent, un nombre arrivé en chaîne ou un fuseau inconnu
 * passent la validation métier, s'écrivent en base, puis font lever le serveur
 * au démarrage suivant. Il ne redémarre alors plus jamais.
 *
 * Pas de bibliothèque de schéma : le projet n'a qu'une poignée de types, et
 * une dépendance de plus à surveiller sur une machine qui doit tourner des
 * années ne vaut pas les quelques dizaines de lignes qu'elle économiserait.
 * Chaque refus nomme le chemin fautif et dit ce qu'on attendait.
 */
import type { CapField, Connection, Transform } from './wiring.js';
import type { DeviceConfig, HouseConfig, SceneConfig, ZoneConfig } from './config.js';

const TYPES = new Set(['light', 'dimmer', 'cover', 'thermostat', 'sensor']);
const METRIQUES = new Set([
  'temperature', 'humidity', 'lux', 'ph', 'orp', 'power', 'water_flow', 'contact', 'battery',
]);
const CANAUX = new Set(['sim', 'mqtt', 'http', 'modbus', 'homeassistant']);
const GENRES_ZONE = new Set([
  'living', 'bedroom', 'bathroom', 'circulation', 'utility', 'outdoor', 'pool', 'general',
]);
const CHAMPS: ReadonlySet<string> = new Set<CapField>([
  'switch.state', 'dim.level', 'cover.position', 'cover.moving',
  'climate.setpoint', 'climate.ambient', 'climate.demand', 'sensor.value',
]);
const COMMANDES = new Set(['switch', 'dim', 'cover', 'climate']);
const TRANSFORMS = new Set(['number', 'bool', 'scale', 'round', 'clamp', 'invert', 'map']);

type Rec = Record<string, unknown>;

const estObjet = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const estTexte = (v: unknown): v is string => typeof v === 'string';
const estNombre = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const estBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Le premier défaut rencontré, ou `null` si la forme est bonne. */
export function verifierForme(cfg: unknown): string | null {
  try {
    forme(cfg);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function refus(chemin: string, attendu: string): never {
  throw new Error(`${chemin} : ${attendu}.`);
}

function texte(o: Rec, cle: string, chemin: string, vide = false): string {
  const v = o[cle];
  if (!estTexte(v) || (!vide && !v.trim())) refus(`${chemin}.${cle}`, 'texte attendu');
  return v;
}
function nombre(o: Rec, cle: string, chemin: string, min = -Infinity, max = Infinity): number {
  const v = o[cle];
  if (!estNombre(v) || v < min || v > max)
    refus(`${chemin}.${cle}`, `nombre attendu${min > -Infinity ? ` (au moins ${min})` : ''}`);
  return v;
}
function bool(o: Rec, cle: string, chemin: string): boolean {
  const v = o[cle];
  if (!estBool(v)) refus(`${chemin}.${cle}`, 'oui / non attendu');
  return v;
}
function parmi(o: Rec, cle: string, chemin: string, valeurs: ReadonlySet<string>): string {
  const v = o[cle];
  if (!estTexte(v) || !valeurs.has(v))
    refus(`${chemin}.${cle}`, `une valeur parmi ${[...valeurs].join(', ')}`);
  return v;
}
function liste(o: Rec, cle: string, chemin: string): unknown[] {
  const v = o[cle];
  if (!Array.isArray(v)) refus(`${chemin}.${cle}`, 'liste attendue');
  return v;
}
function objet(v: unknown, chemin: string): Rec {
  if (!estObjet(v)) refus(chemin, 'objet attendu');
  return v;
}

function forme(cfg: unknown): asserts cfg is HouseConfig {
  const c = objet(cfg, 'config');
  const maison = objet(c.house, 'house');
  texte(maison, 'name', 'house');
  const fuseau = texte(maison, 'timezone', 'house');
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau });
  } catch {
    refus('house.timezone', `fuseau horaire inconnu (« ${fuseau} »)`);
  }

  liste(c, 'connections', 'config').forEach((x, i) => connexion(x, `connections[${i}]`));
  liste(c, 'zones', 'config').forEach((x, i) => zone(x, `zones[${i}]`));
  liste(c, 'devices', 'config').forEach((x, i) => equipement(x, `devices[${i}]`));
  if (c.scenes !== undefined) liste(c, 'scenes', 'config').forEach((x, i) => scene(x, `scenes[${i}]`));
  if (c.cameras !== undefined) liste(c, 'cameras', 'config').forEach((x, i) => camera(x, `cameras[${i}]`));

  const chauffage = objet(c.heating, 'heating');
  const min = nombre(chauffage, 'minSetpoint', 'heating', 0, 40);
  const max = nombre(chauffage, 'maxSetpoint', 'heating', 0, 40);
  if (min >= max) refus('heating.minSetpoint', 'doit être inférieur à maxSetpoint');
  nombre(chauffage, 'nightSetback', 'heating', 0, 20);
  nombre(chauffage, 'awaySetpoint', 'heating', 0, 40);

  if (c.homekit !== undefined) {
    const h = objet(c.homekit, 'homekit');
    bool(h, 'enabled', 'homekit');
    texte(h, 'name', 'homekit');
    texte(h, 'pin', 'homekit');
    nombre(h, 'port', 'homekit', 1, 65535);
  }
  if (c.energy !== undefined) {
    const e = objet(c.energy, 'energy');
    bool(e, 'visible', 'energy');
    texte(e, 'meterDeviceId', 'energy', true);
    nombre(e, 'pricePerKwh', 'energy', 0);
  }
}

function connexion(v: unknown, chemin: string): asserts v is Connection {
  const o = objet(v, chemin);
  texte(o, 'id', chemin);
  parmi(o, 'kind', chemin, CANAUX);
  texte(o, 'label', chemin);
  bool(o, 'enabled', chemin);
  const s = objet(o.settings, `${chemin}.settings`);
  for (const [cle, val] of Object.entries(s)) {
    // Les réglages sont tous facultatifs, mais quand ils sont là, ils ont un type.
    const chemins = `${chemin}.settings.${cle}`;
    if (val === undefined || val === null) continue;
    if (cle === 'headers') {
      const h = objet(val, chemins);
      for (const [k, x] of Object.entries(h)) if (!estTexte(x)) refus(`${chemins}.${k}`, 'texte attendu');
    } else if (['port', 'unitId', 'pollSeconds', 'scanFrom', 'scanCount'].includes(cle)) {
      if (!estNombre(val) || val < 0) refus(chemins, 'nombre attendu');
    } else if (!estTexte(val)) refus(chemins, 'texte attendu');
  }
}

function zone(v: unknown, chemin: string): asserts v is ZoneConfig {
  const o = objet(v, chemin);
  texte(o, 'id', chemin);
  texte(o, 'label', chemin, true);
  parmi(o, 'kind', chemin, GENRES_ZONE);
  nombre(o, 'order', chemin);
  bool(o, 'heated', chemin);
  if (o.plan !== undefined)
    liste(o, 'plan', chemin).forEach((r, i) => {
      const rect = objet(r, `${chemin}.plan[${i}]`);
      for (const k of ['x', 'y', 'w', 'h']) nombre(rect, k, `${chemin}.plan[${i}]`);
    });
}

function equipement(v: unknown, chemin: string): asserts v is DeviceConfig {
  const o = objet(v, chemin);
  texte(o, 'id', chemin);
  texte(o, 'zoneId', chemin);
  texte(o, 'label', chemin, true);
  const type = parmi(o, 'type', chemin, TYPES);
  if (type === 'sensor') parmi(o, 'metric', chemin, METRIQUES);
  nombre(o, 'order', chemin);
  nombre(o, 'staleAfterSeconds', chemin, 1);
  const sim = objet(o.sim, `${chemin}.sim`);
  for (const k of ['travelSeconds', 'base', 'noise', 'driftPerHour', 'inertie'])
    if (sim[k] !== undefined && !estNombre(sim[k])) refus(`${chemin}.sim.${k}`, 'nombre attendu');
  if (o.binding !== null && o.binding !== undefined) raccordement(o.binding, `${chemin}.binding`);
}

function raccordement(v: unknown, chemin: string): void {
  const o = objet(v, chemin);
  texte(o, 'connectionId', chemin);
  liste(o, 'reads', chemin).forEach((r, i) => {
    const l = objet(r, `${chemin}.reads[${i}]`);
    texte(l, 'source', `${chemin}.reads[${i}]`);
    texte(l, 'path', `${chemin}.reads[${i}]`, true);
    parmi(l, 'into', `${chemin}.reads[${i}]`, CHAMPS);
    liste(l, 'pipeline', `${chemin}.reads[${i}]`).forEach((t, j) =>
      transformation(t, `${chemin}.reads[${i}].pipeline[${j}]`),
    );
  });
  liste(o, 'writes', chemin).forEach((w, i) => {
    const e = objet(w, `${chemin}.writes[${i}]`);
    parmi(e, 'on', `${chemin}.writes[${i}]`, COMMANDES);
    texte(e, 'target', `${chemin}.writes[${i}]`);
    texte(e, 'payload', `${chemin}.writes[${i}]`, true);
    liste(e, 'pipeline', `${chemin}.writes[${i}]`).forEach((t, j) =>
      transformation(t, `${chemin}.writes[${i}].pipeline[${j}]`),
    );
  });
}

function transformation(v: unknown, chemin: string): asserts v is Transform {
  const o = objet(v, chemin);
  const op = parmi(o, 'op', chemin, TRANSFORMS);
  switch (op) {
    case 'bool':
      liste(o, 'truthy', chemin).forEach((t, i) => {
        if (!estTexte(t)) refus(`${chemin}.truthy[${i}]`, 'texte attendu');
      });
      break;
    case 'scale':
      nombre(o, 'factor', chemin);
      nombre(o, 'offset', chemin);
      break;
    case 'round':
      nombre(o, 'decimals', chemin, 0, 10);
      break;
    case 'clamp':
      nombre(o, 'min', chemin);
      nombre(o, 'max', chemin);
      break;
    case 'invert':
      nombre(o, 'span', chemin);
      break;
    case 'map': {
      const t = objet(o.table, `${chemin}.table`);
      for (const [k, x] of Object.entries(t))
        if (!estTexte(x) && !estNombre(x) && !estBool(x))
          refus(`${chemin}.table.${k}`, 'texte, nombre ou oui / non attendu');
      break;
    }
  }
}

function scene(v: unknown, chemin: string): asserts v is SceneConfig {
  const o = objet(v, chemin);
  texte(o, 'id', chemin);
  texte(o, 'label', chemin, true);
  texte(o, 'icon', chemin, true);
  nombre(o, 'order', chemin);
  bool(o, 'enabled', chemin);
  const d = objet(o.trigger, `${chemin}.trigger`);
  const kind = parmi(d, 'kind', `${chemin}.trigger`, new Set(['manual', 'time']));
  if (kind === 'time') {
    const at = texte(d, 'at', `${chemin}.trigger`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) refus(`${chemin}.trigger.at`, 'heure « HH:MM » attendue');
    liste(d, 'days', `${chemin}.trigger`).forEach((j, i) => {
      if (!estNombre(j) || j < 0 || j > 6 || !Number.isInteger(j))
        refus(`${chemin}.trigger.days[${i}]`, 'jour de 0 à 6 attendu');
    });
  }
  const c = objet(o.condition, `${chemin}.condition`);
  const ck = parmi(c, 'kind', `${chemin}.condition`, new Set(['always', 'device']));
  if (ck === 'device') {
    texte(c, 'deviceId', `${chemin}.condition`);
    parmi(c, 'is', `${chemin}.condition`, new Set(['on', 'off']));
  }
  liste(o, 'actions', chemin).forEach((a, i) => {
    const act = objet(a, `${chemin}.actions[${i}]`);
    texte(act, 'deviceId', `${chemin}.actions[${i}]`);
    const cmd = objet(act.command, `${chemin}.actions[${i}].command`);
    const ck2 = parmi(cmd, 'kind', `${chemin}.actions[${i}].command`, COMMANDES);
    if (ck2 === 'switch') bool(cmd, 'state', `${chemin}.actions[${i}].command`);
    if (ck2 === 'dim') nombre(cmd, 'level', `${chemin}.actions[${i}].command`, 0, 100);
    if (ck2 === 'cover') nombre(cmd, 'position', `${chemin}.actions[${i}].command`, 0, 100);
    if (ck2 === 'climate') nombre(cmd, 'setpoint', `${chemin}.actions[${i}].command`, 0, 40);
    if (act.afterSeconds !== undefined) nombre(act, 'afterSeconds', `${chemin}.actions[${i}]`, 0);
  });
}

function camera(v: unknown, chemin: string): void {
  const o = objet(v, chemin);
  texte(o, 'id', chemin);
  texte(o, 'label', chemin, true);
  texte(o, 'zoneId', chemin, true);
  nombre(o, 'order', chemin);
  bool(o, 'enabled', chemin);
  texte(o, 'snapshotUrl', chemin, true);
  texte(o, 'username', chemin, true);
  texte(o, 'password', chemin, true);
  nombre(o, 'refreshSeconds', chemin, 1);
}
