import type { DeviceType, Metric } from './types.js';
import type { Binding, Connection } from './wiring.js';

/**
 * Toute la maison tient dans cet objet.
 *
 * Aucune zone, aucun équipement n'est écrit en dur dans le code : tout se
 * paramètre depuis l'interface. Le jour où le matériel arrive, on remplit le
 * champ `binding` de chaque équipement et on bascule `driver` sur 'mqtt'.
 * Rien d'autre ne change.
 */
export interface HouseConfig {
  version: number;
  house: {
    name: string;
    timezone: string;
  };
  /**
   * Les canaux vers le monde extérieur. Plusieurs peuvent tourner en même
   * temps : un broker MQTT pour les modules, une API HTTP pour la piscine, et
   * le simulateur pour tout ce qui n'est pas encore installé.
   */
  connections: Connection[];
  heating: HeatingSettings;
  pool: PoolSettings;
  /** Le pont vers l'app Maison d'Apple. Éteint tant qu'on ne l'allume pas. */
  homekit: HomeKitSettings;
  energy: EnergySettings;
  /** Les caméras. Vide par défaut, et c'est voulu. */
  cameras: CameraConfig[];
  zones: ZoneConfig[];
  devices: DeviceConfig[];
  scenes: SceneConfig[];
}

/**
 * Une scène : un geste, plusieurs équipements.
 *
 * C'est ce qui fait la différence entre piloter une maison et l'habiter : on
 * ne dit pas « éteins ces onze lampes et ferme ces treize volets », on dit
 * « bonne nuit ».
 */
export interface SceneConfig {
  id: string;
  label: string;
  /** Nom d'icône du jeu de l'application. */
  icon: string;
  order: number;
  /**
   * Une scène au repos ne part JAMAIS toute seule. On peut toujours la jouer
   * à la main : c'est la différence entre « désactivée » et « supprimée », et
   * c'est ce qui permet de couper le réveil le temps des vacances sans perdre
   * son réglage.
   */
  enabled: boolean;
  trigger: SceneTrigger;
  condition: SceneCondition;
  actions: SceneAction[];
}

/**
 * QUAND la scène part.
 *
 * Volontairement court. Le géorepérage et la présence demandent des sources
 * qu'on n'a pas : inventer un déclencheur qui ne peut pas se produire rendrait
 * l'interface menteuse. La voix, elle, existe déjà : par Siri, via le pont
 * HomeKit, et ne passe pas par ici.
 */
export type SceneTrigger =
  | { kind: 'manual' }
  /** `at` au format « HH:MM », `days` de 0 (dimanche) à 6 (samedi). */
  | { kind: 'time'; at: string; days: number[] };

/**
 * SI la scène a le droit de partir.
 *
 * Une garde, pas un second déclencheur : elle est évaluée au moment où le
 * déclencheur se produit, et rien d'autre.
 */
export type SceneCondition =
  | { kind: 'always' }
  /** Vrai quand l'équipement est dans l'état demandé. Injoignable = faux. */
  | { kind: 'device'; deviceId: string; is: 'on' | 'off' };

export interface SceneAction {
  deviceId: string;
  command: SceneCommand;
  /**
   * Retard après le départ de la scène, en secondes.
   *
   * C'est ce qui permet « les portes se verrouillent 30 secondes après le
   * départ » : sans lui, une scène ne sait dire qu'un instant, jamais une
   * suite.
   */
  afterSeconds?: number;
}

/** Les jours, dans l'ordre de `Date.getDay()`. */
export const JOURS_COURTS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'] as const;
export const JOURS_LONGS = [
  'dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi',
] as const;

export const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6];
export const EN_SEMAINE = [1, 2, 3, 4, 5];
export const LE_WEEKEND = [0, 6];

/** Les mêmes commandes que le domaine, stockées telles quelles. */
export type SceneCommand =
  | { kind: 'switch'; state: boolean }
  | { kind: 'dim'; level: number }
  | { kind: 'cover'; position: number }
  | { kind: 'climate'; setpoint: number };

export interface HeatingSettings {
  /**
   * 'single'  : une seule régulation pour toute la maison (cas actuel).
   * 'zoned'   : un émetteur pilotable par zone.
   * Le modèle est identique dans les deux cas : seul le nombre d'actionneurs change.
   */
  mode: 'single' | 'zoned';
  /** Détermine l'inertie, donc la stratégie d'anticipation et de réduit. */
  emitter: 'air' | 'water' | 'floor' | 'unknown';
  minSetpoint: number;
  maxSetpoint: number;
  /** Réduit nocturne, en degrés sous la consigne de confort. */
  nightSetback: number;
  /** Repli en cas d'absence prolongée. */
  awaySetpoint: number;
}

/**
 * Le pont HomeKit.
 *
 * Il expose la maison à l'app Maison d'Apple, donc à Siri, aux automatisations
 * d'Apple et aux autres membres du foyer, sans rien changer au modèle : le
 * pont lit l'état du cerveau et lui transmet les commandes, exactement comme
 * l'interface web. Les deux règles tiennent : un interrupteur poussé depuis
 * Siri ne change l'affichage que lorsque le matériel a confirmé.
 *
 * Éteint par défaut. L'allumer publie un service sur le réseau local et affiche
 * un code d'association : ce n'est pas une décision à prendre à la place de
 * quelqu'un.
 */
export interface HomeKitSettings {
  enabled: boolean;
  /** Le nom du pont tel qu'il apparaît dans l'app Maison. */
  name: string;
  /** Le code d'association, de la forme 031-45-154. */
  pin: string;
  port: number;
}

export const HOMEKIT_DEFAUT: HomeKitSettings = {
  enabled: false,
  name: 'La Ruche',
  // Le code par défaut d'Apple pour les exemples. Il DOIT être changé : un
  // code public sur un réseau partagé ouvre la maison à qui le connaît.
  pin: '031-45-154',
  port: 51826,
};

/** Le code d'association doit avoir exactement cette forme, sinon iOS le refuse. */
export function pinHomeKitValide(pin: string): boolean {
  if (!/^\d{3}-\d{2}-\d{3}$/.test(pin)) return false;
  // Apple refuse les codes trop réguliers : ils sont devinables.
  const chiffres = pin.replace(/-/g, '');
  const interdits = ['00000000', '11111111', '22222222', '33333333', '44444444',
                     '55555555', '66666666', '77777777', '88888888', '99999999',
                     '12345678', '87654321'];
  return !interdits.includes(chiffres);
}

/**
 * Une caméra.
 *
 * Trois choix de fond, tous dictés par la même idée : le navigateur ne parle
 * jamais à la caméra.
 *
 * 1. **L'image passe par le serveur.** Il récupère l'instantané et le renvoie.
 *    Sans ça il faudrait mettre les identifiants de la caméra dans la page,
 *    donc dans l'historique du navigateur et dans les journaux du réseau.
 * 2. **On affiche un instantané rafraîchi, pas un flux.** Le direct demande de
 *    transcoder du RTSP en HLS ou en WebRTC, donc un ffmpeg qui tourne en
 *    permanence. Une image toutes les deux secondes suffit à voir qui sonne,
 *    et tient sur un Raspberry Pi.
 * 3. **Éteinte par défaut.** Une caméra qu'on a oublié d'éteindre filme quand
 *    même.
 *
 * Les images ne sont servies qu'aux comptes connectés de rang « habitant » ou
 * plus : un invité ne les voit pas. Les identifiants de la caméra, eux, ne
 * sont rendus qu'à l'administrateur.
 */
export interface CameraConfig {
  id: string;
  label: string;
  /** Pièce où elle se trouve. Vide pour l'extérieur ou le non rattaché. */
  zoneId: string;
  order: number;
  enabled: boolean;
  /** Adresse de l'image fixe, telle que le SERVEUR la joindra. */
  snapshotUrl: string;
  /** Identifiants de la caméra. Ils ne quittent jamais le serveur. */
  username: string;
  password: string;
  /** Secondes entre deux images. */
  refreshSeconds: number;
}

/**
 * Le suivi de consommation.
 *
 * Un seul compteur, celui de la maison entière. La répartition par usage : * chauffage, eau chaude, cuisine : demande une mesure par circuit ou par
 * prise, que le compteur général ne peut pas fournir : la déduire d'un total
 * reviendrait à l'inventer.
 *
 * Le tarif vaut zéro tant qu'on ne l'a pas saisi, et l'interface dit alors
 * « tarif non renseigné » plutôt que d'afficher un montant vraisemblable et
 * faux.
 */
export interface EnergySettings {
  /**
   * Faire apparaître l'écran dans le menu.
   *
   * Tant qu'aucun compteur n'est branché, l'écran n'a presque rien à dire :
   * une entrée de menu qui mène à un graphique vide use la confiance. On le
   * range jusqu'à ce qu'il serve.
   */
  visible: boolean;
  /** L'équipement qui mesure la maison. Vide = pas de suivi possible. */
  meterDeviceId: string;
  /** Prix du kilowattheure, toutes taxes comprises. */
  pricePerKwh: number;
}

export const ENERGY_DEFAUT: EnergySettings = {
  visible: false,
  meterDeviceId: '',
  pricePerKwh: 0,
};

export interface PoolSettings {
  enabled: boolean;
  treatment: 'chlore' | 'sel' | 'brome' | 'unknown';
  /** Plage acceptable. Hors de cette plage, l'app alerte : elle n'injecte jamais. */
  phTarget: [number, number];
  orpTarget: [number, number];
}

export type ZoneKind =
  | 'living'
  | 'bedroom'
  | 'bathroom'
  | 'circulation'
  | 'utility'
  | 'outdoor'
  | 'pool'
  | 'general';

export const ZONE_KIND_LABELS: Record<ZoneKind, string> = {
  living: 'Pièce de vie',
  bedroom: 'Chambre',
  bathroom: "Salle d'eau",
  circulation: 'Circulation',
  utility: 'Service',
  outdoor: 'Extérieur',
  pool: 'Piscine',
  general: 'Général',
};

/** Un rectangle du plan, dans le repère du SVG (voir PLAN_VIEWBOX). */
export interface PlanRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PLAN_VIEWBOX = { w: 660, h: 350 } as const;

/**
 * Emprise d'un ouvrant sur le plan, en segment de mur.
 * Permet de dessiner l'état réel des volets à même le plan : on voit d'un coup
 * d'œil lesquels sont fermés, sans lire un seul mot.
 */
export interface PlanOpening {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ZoneConfig {
  id: string;
  label: string;
  kind: ZoneKind;
  order: number;
  /** Emprise sur le plan. Vide = la zone n'apparaît pas sur le plan (extérieur, général). */
  plan?: PlanRect[];
  heated: boolean;
}

/** Réglages du comportement simulé : ignorés dès qu'un binding existe. */
export interface SimProfile {
  /** Volet : durée de course complète, en secondes. */
  travelSeconds?: number;
  /** Capteur : valeur de repos. */
  base?: number;
  /** Capteur : amplitude du bruit autour de la valeur de repos. */
  noise?: number;
  /** Capteur : dérive par heure (le pH monte, une pile descend…). */
  driftPerHour?: number;
  /** Thermostat : vitesse de rapprochement de la consigne, en °C par pas. */
  inertie?: number;
}

export interface DeviceConfig {
  id: string;
  zoneId: string;
  label: string;
  type: DeviceType;
  /** Uniquement pour type === 'sensor'. */
  metric?: Metric;
  order: number;
  /** Au-delà de ce délai sans nouvelle, l'équipement passe en `stale`. */
  staleAfterSeconds: number;
  binding: Binding | null;
  sim: SimProfile;
  /** Uniquement pour les volets : où se trouve l'ouvrant sur le plan. */
  opening?: PlanOpening;
}

// ---------------------------------------------------------------- validation

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Validation métier, volontairement lisible plutôt qu'exhaustive.
 * Elle protège contre ce qui casse vraiment : identifiants en double,
 * zones fantômes, capteurs sans grandeur.
 */
export function validateConfig(cfg: HouseConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const zoneIds = new Set<string>();

  for (const [i, z] of cfg.zones.entries()) {
    if (!z.id.trim()) issues.push({ path: `zones[${i}].id`, message: 'Identifiant vide.' });
    if (zoneIds.has(z.id))
      issues.push({ path: `zones[${i}].id`, message: `Identifiant « ${z.id} » en double.` });
    zoneIds.add(z.id);
    if (!z.label.trim())
      issues.push({ path: `zones[${i}].label`, message: 'Une zone doit avoir un nom.' });
  }

  const deviceIds = new Set<string>();
  for (const [i, d] of cfg.devices.entries()) {
    const where = `devices[${i}]`;
    if (!d.id.trim()) issues.push({ path: `${where}.id`, message: 'Identifiant vide.' });
    if (deviceIds.has(d.id))
      issues.push({ path: `${where}.id`, message: `Identifiant « ${d.id} » en double.` });
    deviceIds.add(d.id);
    if (!zoneIds.has(d.zoneId))
      issues.push({
        path: `${where}.zoneId`,
        message: `« ${d.label} » référence la zone inconnue « ${d.zoneId} ».`,
      });
    if (d.type === 'sensor' && !d.metric)
      issues.push({ path: `${where}.metric`, message: `« ${d.label} » : grandeur mesurée manquante.` });
  }

  const connIds = new Set<string>();
  for (const [i, c] of cfg.connections.entries()) {
    if (connIds.has(c.id))
      issues.push({ path: `connections[${i}].id`, message: `Connexion « ${c.id} » en double.` });
    connIds.add(c.id);
    if (c.kind === 'mqtt' && c.enabled && !c.settings.url?.trim())
      issues.push({ path: `connections[${i}].url`, message: `« ${c.label} » : adresse du broker manquante.` });
    if (c.kind === 'http' && c.enabled && !c.settings.baseUrl?.trim())
      issues.push({ path: `connections[${i}].baseUrl`, message: `« ${c.label} » : adresse de base manquante.` });
    if (c.kind === 'modbus' && c.enabled && !c.settings.host?.trim())
      issues.push({ path: `connections[${i}].host`, message: `« ${c.label} » : adresse de l’équipement manquante.` });
  }

  for (const [i, d] of cfg.devices.entries()) {
    const b = d.binding;
    if (!b) continue;
    if (!connIds.has(b.connectionId))
      issues.push({
        path: `devices[${i}].binding`,
        message: `« ${d.label} » pointe vers la connexion inconnue « ${b.connectionId} ».`,
      });
    if (!b.reads.length && !b.writes.length)
      issues.push({
        path: `devices[${i}].binding`,
        message: `« ${d.label} » est raccordé mais n'a ni lecture ni écriture.`,
      });
  }

  for (const [i, sc] of (cfg.scenes ?? []).entries()) {
    if (!sc.label.trim())
      issues.push({ path: `scenes[${i}].label`, message: 'Une scène doit avoir un nom.' });

    const t = sc.trigger;
    if (t?.kind === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at))
        issues.push({
          path: `scenes[${i}].trigger.at`,
          message: `« ${sc.label} » : l’heure « ${t.at} » n’est pas au format 07:00.`,
        });
      if (!t.days?.length)
        issues.push({
          path: `scenes[${i}].trigger.days`,
          message: `« ${sc.label} » part à heure fixe mais aucun jour n’est coché : elle ne partirait jamais.`,
        });
      if (t.days?.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
        issues.push({
          path: `scenes[${i}].trigger.days`,
          message: `« ${sc.label} » : jour hors de 0 (dimanche) à 6 (samedi).`,
        });
    }

    const c = sc.condition;
    if (c?.kind === 'device' && !deviceIds.has(c.deviceId))
      issues.push({
        path: `scenes[${i}].condition`,
        message: `« ${sc.label} » dépend de l’équipement inconnu « ${c.deviceId} ».`,
      });

    const retards = sc.actions.filter(
      (a) => a.afterSeconds !== undefined && (a.afterSeconds < 0 || a.afterSeconds > 3600),
    ).length;
    if (retards)
      issues.push({
        path: `scenes[${i}].actions`,
        message: `« ${sc.label} » : ${retards} retard(s) hors de 0 à 3600 secondes.`,
      });
    const fantomes = sc.actions.filter((a) => !deviceIds.has(a.deviceId)).length;
    if (fantomes)
      issues.push({
        path: `scenes[${i}].actions`,
        message: `« ${sc.label} » vise ${fantomes} équipement(s) qui n'existent plus.`,
      });
  }

  const orphelins = cfg.devices.filter((d) => !d.binding).length;
  if (orphelins)
    issues.push({
      path: 'devices',
      message: `${orphelins} équipement(s) non raccordés resteront simulés.`,
    });

  if (cfg.homekit?.enabled && !pinHomeKitValide(cfg.homekit.pin))
    issues.push({
      path: 'homekit.pin',
      message: 'Le code d’association doit avoir la forme 031-45-154, et ne pas être une suite évidente.',
    });
  if (cfg.homekit?.enabled && cfg.homekit.pin === HOMEKIT_DEFAUT.pin)
    issues.push({
      path: 'homekit.pin',
      message: 'Le code d’association est encore celui d’usine : change-le avant d’ouvrir le pont.',
    });

  const camIds = new Set<string>();
  for (const [i, c] of (cfg.cameras ?? []).entries()) {
    const ou = `cameras[${i}]`;
    if (camIds.has(c.id))
      issues.push({ path: `${ou}.id`, message: `Caméra « ${c.id} » en double.` });
    camIds.add(c.id);
    if (!c.label.trim())
      issues.push({ path: `${ou}.label`, message: 'Une caméra doit avoir un nom.' });
    if (c.zoneId && !zoneIds.has(c.zoneId))
      issues.push({ path: `${ou}.zoneId`, message: `« ${c.label} » référence la zone inconnue « ${c.zoneId} ».` });
    if (c.enabled && !/^https?:\/\//i.test(c.snapshotUrl ?? ''))
      issues.push({
        path: `${ou}.snapshotUrl`,
        message: `« ${c.label} » : adresse d’image manquante ou invalide : attendu http:// ou https://`,
      });
    if (c.refreshSeconds < 1 || c.refreshSeconds > 3600)
      issues.push({ path: `${ou}.refreshSeconds`, message: `« ${c.label} » : rafraîchissement hors de 1 à 3600 s.` });
  }
  const allumees = (cfg.cameras ?? []).filter((c) => c.enabled).length;
  if (allumees)
    issues.push({
      path: 'cameras',
      message: `${allumees} caméra(s) active(s) : leurs images sont visibles par tout compte « habitant » ou « administrateur ».`,
    });

  if (cfg.energy?.meterDeviceId && !deviceIds.has(cfg.energy.meterDeviceId))
    issues.push({
      path: 'energy.meterDeviceId',
      message: `Le compteur « ${cfg.energy.meterDeviceId} » n’existe pas.`,
    });
  if (cfg.energy && cfg.energy.pricePerKwh < 0)
    issues.push({ path: 'energy.pricePerKwh', message: 'Le prix du kWh ne peut pas être négatif.' });

  if (cfg.heating.minSetpoint >= cfg.heating.maxSetpoint)
    issues.push({ path: 'heating', message: 'La consigne minimale doit être inférieure à la maximale.' });

  return issues;
}

/**
 * Les avertissements n'empêchent pas d'enregistrer ; les erreurs si.
 * Avoir des équipements simulés est un état parfaitement normal : c'est même
 * tout l'intérêt : on équipe la maison pièce par pièce.
 */
export function isBlocking(issue: ConfigIssue): boolean {
  if (issue.message.includes('resteront simulés')) return false;
  // Le code d'usine est imprudent, pas cassé : on le dit fort, sans empêcher
  // d'enregistrer. Une forme invalide, elle, empêche iOS d'associer, donc bloque.
  if (issue.message.includes('encore celui d’usine')) return false;
  // Les caméras actives sont un AVERTISSEMENT, pas une erreur : c'est un
  // risque qu'on a le droit d'accepter chez soi, à condition de le savoir.
  if (issue.message.includes('caméra(s) active(s)')) return false;
  return true;
}

/** Identifiant de la connexion « simulateur », toujours présente. */
export const SIM_CONNECTION = 'sim';
