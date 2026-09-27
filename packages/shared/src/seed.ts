import { ENERGY_DEFAUT, HOMEKIT_DEFAUT, EN_SEMAINE, TOUS_LES_JOURS } from './config.js';
import type { DeviceConfig, HouseConfig, PlanRect, SceneConfig, ZoneConfig, ZoneKind } from './config.js';
import type { DeviceType, Metric } from './types.js';

/**
 * La maison telle qu'on la lit sur le plan : 13 zones habitées, plus une zone
 * « Général » pour ce qui n'appartient à aucune pièce, la piscine et l'extérieur.
 *
 * Ces chiffres sont une ESTIMATION issue de la capture du plan. Tout est
 * modifiable depuis l'écran Paramétrage — ce fichier ne sert qu'à ce que
 * l'application s'ouvre déjà sur quelque chose de reconnaissable.
 */

interface ZoneSeed {
  id: string;
  label: string;
  kind: ZoneKind;
  plan?: PlanRect[];
  heated?: boolean;
  devices: DeviceSeed[];
}

interface DeviceSeed {
  slug: string;
  label: string;
  type: DeviceType;
  metric?: Metric;
  base?: number;
  noise?: number;
  driftPerHour?: number;
  travelSeconds?: number;
  opening?: { x1: number; y1: number; x2: number; y2: number };
}

const T = (base: number): DeviceSeed => ({
  slug: 'temperature',
  label: 'Température',
  type: 'sensor',
  metric: 'temperature',
  base,
  noise: 0.15,
});

const H = (base: number): DeviceSeed => ({
  slug: 'humidite',
  label: 'Humidité',
  type: 'sensor',
  metric: 'humidity',
  base,
  noise: 1.5,
});

const OUVRANT = (label = 'Ouvrant'): DeviceSeed => ({
  slug: 'ouvrant',
  label,
  type: 'sensor',
  metric: 'contact',
});

/** Un volet, et l'ouvrant qu'il équipe sur le plan. */
const VOLET = (
  slug: string,
  label: string,
  opening: { x1: number; y1: number; x2: number; y2: number },
): DeviceSeed => ({
  slug,
  label,
  type: 'cover',
  travelSeconds: 22,
  opening,
});

const ZONES: ZoneSeed[] = [
  {
    id: 'z00',
    label: 'Général',
    kind: 'general',
    heated: false,
    devices: [
      { slug: 'chauffage', label: 'Chauffage général', type: 'thermostat' },
      { slug: 'conso', label: 'Consommation maison', type: 'sensor', metric: 'power', base: 620, noise: 180 },
      { slug: 'conso-pac', label: 'Consommation PAC', type: 'sensor', metric: 'power', base: 950, noise: 320 },
    ],
  },
  {
    id: 'z01',
    label: 'Cuisine',
    kind: 'living',
    plan: [{ x: 30, y: 30, w: 102, h: 184 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      { slug: 'plan-travail', label: 'Plan de travail', type: 'dimmer' },
      T(20.4),
      H(48),
    ],
  },
  {
    id: 'z02',
    label: 'Buanderie',
    kind: 'utility',
    plan: [{ x: 30, y: 214, w: 102, h: 95 }],
    heated: false,
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      T(17.8),
      H(58),
      { slug: 'fuite', label: "Détecteur de fuite", type: 'sensor', metric: 'contact' },
    ],
  },
  {
    id: 'z03',
    label: 'Salon séjour',
    kind: 'living',
    plan: [
      { x: 132, y: 30, w: 193, h: 143 },
      { x: 132, y: 173, w: 114, h: 114 },
    ],
    devices: [
      { slug: 'general', label: 'Général', type: 'dimmer' },
      { slug: 'liseuse', label: 'Liseuse', type: 'light' },
      { slug: 'ambiance', label: 'Ambiance', type: 'dimmer' },
      // À droite de la véranda, sur le même pan nord. Le salon n'a pas
      // d'ouvrant au sud : le mur y est plein.
      VOLET('volet-fenetre', 'Fenêtre', { x1: 282, y1: 30, x2: 312, y2: 30 }),
      // Une seule véranda sur tout le pan nord, et non trois ouvrants côte à
      // côte : c'est une baie continue, elle se commande d'un seul tenant.
      VOLET('volet-veranda', 'Véranda', { x1: 158, y1: 30, x2: 262, y2: 30 }),
      T(20.6),
      { slug: 'luminosite', label: 'Luminosité', type: 'sensor', metric: 'lux', base: 240, noise: 60 },
    ],
  },
  {
    id: 'z04',
    label: 'Entrée',
    kind: 'circulation',
    plan: [
      { x: 246, y: 173, w: 58, h: 65 },
      { x: 246, y: 238, w: 32, h: 49 },
    ],
    heated: false,
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      { slug: 'placard-1', label: 'Placard 1', type: 'light' },
      { slug: 'porte', label: "Porte d'entrée", type: 'sensor', metric: 'contact' },
    ],
  },
  {
    id: 'z05',
    label: 'WC',
    kind: 'bathroom',
    plan: [{ x: 278, y: 238, w: 26, h: 49 }],
    heated: false,
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
    ],
  },
  {
    id: 'z06',
    label: 'Salle de bains',
    kind: 'bathroom',
    plan: [{ x: 325, y: 30, w: 75, h: 112 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      { slug: 'miroir', label: 'Miroir', type: 'light' },
      { slug: 'placard-2', label: 'Placard 2', type: 'light' },
      VOLET('volet', 'Volet', { x1: 342, y1: 30, x2: 384, y2: 30 }),
      T(21.5),
      H(62),
    ],
  },
  {
    id: 'z07',
    label: 'Chambre 1',
    kind: 'bedroom',
    plan: [{ x: 400, y: 30, w: 104, h: 112 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'dimmer' },
      { slug: 'chevet-g', label: 'Chevet gauche', type: 'light' },
      { slug: 'chevet-d', label: 'Chevet droit', type: 'light' },
      VOLET('volet', 'Volet', { x1: 422, y1: 30, x2: 478, y2: 30 }),
      T(19.2),
      OUVRANT('Fenêtre'),
    ],
  },
  {
    id: 'z08',
    label: 'Chambre 2',
    kind: 'bedroom',
    plan: [{ x: 304, y: 173, w: 96, h: 114 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      VOLET('volet', 'Volet', { x1: 322, y1: 287, x2: 378, y2: 287 }),
      T(19.0),
      OUVRANT('Fenêtre'),
    ],
  },
  {
    id: 'z09',
    label: 'Chambre 3',
    kind: 'bedroom',
    plan: [{ x: 400, y: 173, w: 80, h: 114 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      VOLET('volet', 'Volet', { x1: 414, y1: 287, x2: 464, y2: 287 }),
      T(19.1),
      OUVRANT('Fenêtre'),
    ],
  },
  {
    id: 'z10',
    label: 'Chambre 4',
    kind: 'bedroom',
    plan: [
      { x: 480, y: 173, w: 135, h: 114 },
      { x: 504, y: 142, w: 86, h: 31 },
    ],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      VOLET('volet', 'Volet', { x1: 502, y1: 287, x2: 560, y2: 287 }),
      T(18.8),
      OUVRANT('Fenêtre'),
    ],
  },
  {
    id: 'z11',
    label: "Salle d'eau",
    kind: 'bathroom',
    plan: [{ x: 504, y: 30, w: 86, h: 48 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      { slug: 'miroir', label: 'Miroir', type: 'light' },
      T(21.2),
      H(60),
    ],
  },
  {
    id: 'z12',
    label: 'Dressing',
    kind: 'utility',
    plan: [{ x: 504, y: 78, w: 86, h: 64 }],
    devices: [
      { slug: 'plafond', label: 'Plafond', type: 'light' },
      T(19.6),
    ],
  },
  {
    id: 'z13',
    label: 'Couloir',
    kind: 'circulation',
    plan: [{ x: 325, y: 142, w: 179, h: 31 }],
    devices: [
      { slug: 'nord', label: 'Couloir nord', type: 'light' },
      { slug: 'sud', label: 'Couloir sud', type: 'light' },
      { slug: 'placard-4', label: 'Placard 4', type: 'light' },
      { slug: 'placard-5', label: 'Placard 5', type: 'light' },
      T(19.8),
    ],
  },
  {
    id: 'z20',
    label: 'Piscine',
    kind: 'pool',
    heated: false,
    devices: [
      { slug: 'projecteur', label: 'Projecteur bassin', type: 'light' },
      // Le pH monte naturellement : c'est la dérive qu'on veut voir arriver.
      { slug: 'ph', label: 'pH', type: 'sensor', metric: 'ph', base: 7.3, noise: 0.02, driftPerHour: 0.012 },
      { slug: 'orp', label: 'Potentiel redox', type: 'sensor', metric: 'orp', base: 690, noise: 12 },
      { slug: 'temperature', label: 'Température eau', type: 'sensor', metric: 'temperature', base: 26.5, noise: 0.1 },
    ],
  },
  {
    id: 'z21',
    label: 'Extérieur',
    kind: 'outdoor',
    heated: false,
    devices: [
      { slug: 'facades', label: 'Façades', type: 'light' },
      { slug: 'terrasse', label: 'Terrasse', type: 'dimmer' },
      { slug: 'allee', label: 'Allée', type: 'light' },
      // Sonde au nord, à l'ombre : elle lit la température, pas le soleil.
      { slug: 'temperature', label: 'Température extérieure', type: 'sensor', metric: 'temperature', base: 11.5, noise: 0.4 },
      { slug: 'luminosite', label: 'Luminosité', type: 'sensor', metric: 'lux', base: 8000, noise: 900 },
    ],
  },
];

const CAP_SLUG: Record<DeviceType, string> = {
  light: 'light',
  dimmer: 'light',
  cover: 'cover',
  thermostat: 'climate',
  sensor: 'sensor',
};

/**
 * Les scènes livrées.
 *
 * Principe : une scène par défaut ne touche JAMAIS une chambre, sauf si son
 * nom l'annonce. Un « Réveil » qui ouvre les volets d'une chambre où quelqu'un
 * dort encore n'est pas une commodité, c'est une nuisance.
 *
 * Tout est modifiable depuis l'écran Paramétrage — c'est un point de départ
 * volontairement prudent, pas une vérité.
 */
function buildScenes(devices: DeviceConfig[]): SceneConfig[] {
  const VIE = new Set(['z01', 'z03', 'z13']);        // cuisine, séjour, couloir
  const CHAMBRES = new Set(['z07', 'z08', 'z09', 'z10']);

  const dans = (zones: Set<string>, type: DeviceConfig['type']) =>
    devices.filter((d) => zones.has(d.zoneId) && d.type === type);
  const lampes = devices.filter((d) => d.type === 'light' || d.type === 'dimmer');

  const eteindre = (l: DeviceConfig[]) =>
    l.map((d) => ({ deviceId: d.id, command: { kind: 'switch' as const, state: false } }));
  const volet = (l: DeviceConfig[], position: number) =>
    l.map((d) => ({ deviceId: d.id, command: { kind: 'cover' as const, position } }));

  return [
    {
      // Les pièces de vie uniquement : les chambres restent comme elles sont.
      id: 'reveil', label: 'Réveil', icon: 'soleil', order: 0,
      // L'horaire est proposé, pas imposé : la scène reste AU REPOS tant que
      // personne ne l'a allumée. Ouvrir des volets à 7 h chez quelqu'un qui
      // n'a rien demandé serait décider à sa place.
      enabled: false,
      trigger: { kind: 'time', at: '07:00', days: [...EN_SEMAINE] },
      condition: { kind: 'always' },
      actions: [
        ...volet(dans(VIE, 'cover'), 100),
        ...dans(new Set(['z01']), 'light').map((d) => ({
          deviceId: d.id, command: { kind: 'switch' as const, state: true },
        })),
      ],
    },
    {
      // On éteint partout — mais on ne ferme que les pièces de vie : personne
      // n'a envie de retrouver ses chambres dans le noir en rentrant.
      id: 'depart', label: 'Départ', icon: 'porte', order: 1,
      // À la demande : rien ne permet encore de savoir que la maison est vide.
      enabled: true,
      trigger: { kind: 'manual' },
      condition: { kind: 'always' },
      actions: [...eteindre(lampes), ...volet(dans(VIE, 'cover'), 0)],
    },
    {
      id: 'soiree', label: 'Soirée', icon: 'ampoule', order: 2,
      enabled: true,
      trigger: { kind: 'manual' },
      condition: { kind: 'always' },
      actions: [
        ...dans(new Set(['z03']), 'dimmer').map((d) => ({
          deviceId: d.id, command: { kind: 'dim' as const, level: 35 },
        })),
        ...devices.filter((d) => d.id === 'z03.light.liseuse').map((d) => ({
          deviceId: d.id, command: { kind: 'switch' as const, state: true },
        })),
        ...volet(dans(new Set(['z03']), 'cover'), 0),
      ],
    },
    {
      // La seule qui touche les chambres — et son nom le dit.
      id: 'coucher', label: 'Coucher', icon: 'lune', order: 3,
      enabled: false,
      trigger: { kind: 'time', at: '23:30', days: [...TOUS_LES_JOURS] },
      condition: { kind: 'always' },
      actions: [
        ...eteindre(lampes.filter((d) => !d.id.includes('chevet'))),
        ...devices.filter((d) => d.id.includes('chevet')).map((d) => ({
          deviceId: d.id, command: { kind: 'switch' as const, state: true },
        })),
        ...volet(dans(CHAMBRES, 'cover'), 0),
      ],
    },
  ];
}

export function buildSeedConfig(): HouseConfig {
  const zones: ZoneConfig[] = [];
  const devices: DeviceConfig[] = [];

  ZONES.forEach((z, zi) => {
    zones.push({
      id: z.id,
      label: z.label,
      kind: z.kind,
      order: zi,
      plan: z.plan,
      heated: z.heated ?? true,
    });

    z.devices.forEach((d, di) => {
      devices.push({
        // 'z03.cover.volet-baie' — la zone en préfixe permet d'agir par zone
        // sans table de correspondance, et de s'y retrouver dans un journal.
        id: `${z.id}.${CAP_SLUG[d.type]}.${d.slug}`,
        zoneId: z.id,
        label: d.label,
        type: d.type,
        metric: d.metric,
        order: di,
        // Un capteur sur pile parle toutes les quelques minutes ; un module
        // secteur répond tout de suite. D'où deux délais très différents.
        staleAfterSeconds: d.type === 'sensor' ? 45 * 60 : 5 * 60,
        binding: null,
        opening: d.opening,
        sim: {
          travelSeconds: d.travelSeconds,
          base: d.base,
          noise: d.noise,
          driftPerHour: d.driftPerHour,
        },
      });
    });
  });

  return {
    version: 1,
    house: { name: 'La Ruche', timezone: 'Europe/Paris' },
    // Le simulateur est toujours là et sert tout ce qui n'est pas raccordé.
    // On n'a donc jamais d'écran vide, et on équipe la maison à son rythme.
    connections: [
      { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
    ],
    heating: {
      // Régulation unique aujourd'hui : la maison n'a pas d'émetteur pilotable
      // par pièce. Passer en 'zoned' le jour où elle en aura — rien d'autre à changer.
      mode: 'single',
      emitter: 'unknown',
      minSetpoint: 14,
      maxSetpoint: 24,
      nightSetback: 2,
      awaySetpoint: 16,
    },
    pool: {
      enabled: true,
      treatment: 'unknown',
      phTarget: [7.0, 7.4],
      orpTarget: [650, 750],
    },
    // Éteint : publier la maison sur le réseau est une décision, pas un défaut.
    homekit: { ...HOMEKIT_DEFAUT },
    // Le compteur général est désigné dès le départ, mais l'écran reste rangé
    // et le tarif à zéro : un graphique vide ou des euros au hasard seraient
    // pires que rien.
    energy: { ...ENERGY_DEFAUT, meterDeviceId: 'z00.sensor.conso' },
    // Aucune caméra : on n'en invente pas, et surtout on n'en allume pas.
    cameras: [],
    zones,
    devices,
    scenes: buildScenes(devices),
  };
}
