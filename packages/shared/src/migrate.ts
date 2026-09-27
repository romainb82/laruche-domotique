import { ENERGY_DEFAUT, HOMEKIT_DEFAUT, type HouseConfig } from './config.js';
import type { Binding, Connection } from './wiring.js';

/**
 * Migration des configurations écrites avant le bus d'adaptateurs.
 *
 * L'ancien modèle n'avait qu'un driver global (`sim` ou `mqtt`) et un
 * raccordement à deux topics par équipement. On le convertit en connexions
 * nommées et en lectures/écritures explicites, sans rien perdre.
 *
 * Une base déjà migrée traverse cette fonction sans dommage : elle est
 * idempotente.
 */
export function migrateConfig(raw: unknown): HouseConfig {
  const cfg = raw as HouseConfig & AncienneConfig;

  if (Array.isArray(cfg.connections) && cfg.connections.length) {
    // Les scènes puis le pont HomeKit sont arrivés après : une base d'avant
    // n'en a pas, et doit repartir sur les valeurs par défaut.
    const brutes = Array.isArray(cfg.scenes) ? cfg.scenes : [];
    // Les déclencheurs sont arrivés après les scènes : une scène d'avant n'a
    // ni interrupteur, ni « quand », ni « si ». Elle reste donc manuelle et
    // active, exactement ce qu'elle était — une migration ne doit rien mettre
    // en marche que personne n'a demandé.
    const scenes = brutes.map((sc) => ({
      ...sc,
      enabled: sc.enabled ?? true,
      trigger: sc.trigger ?? { kind: 'manual' as const },
      condition: sc.condition ?? { kind: 'always' as const },
    }));
    const homekit = cfg.homekit ?? HOMEKIT_DEFAUT;
    // Le compteur est retrouvé s'il existe déjà dans la maison : c'est le seul
    // équipement qui mesure le total, et le retrouver vaut mieux que de
    // laisser l'écran vide. Le tarif, lui, ne se devine pas.
    // Les valeurs par défaut sont fusionnées DANS l'objet existant, pas
    // seulement posées quand il manque : une configuration écrite avant
    // l'arrivée d'un champ garde l'objet mais pas le champ, et le réglage
    // resterait introuvable.
    const energy = {
      ...ENERGY_DEFAUT,
      ...(cfg.energy ?? {}),
      // Posés APRÈS l'étalement, sinon l'ancien objet les écraserait par des
      // valeurs absentes.
      meterDeviceId:
        cfg.energy?.meterDeviceId ||
        cfg.devices?.find((d) => d.metric === 'power' && d.zoneId === 'z00')?.id ||
        '',
      visible: cfg.energy?.visible ?? ENERGY_DEFAUT.visible,
    };
    const intact =
      cfg.homekit === homekit &&
      JSON.stringify(cfg.energy ?? null) === JSON.stringify(energy) &&
      Array.isArray(cfg.cameras) &&
      brutes.length === scenes.length &&
      brutes.every((sc, i) => sc === scenes[i]);
    return (intact ? cfg : { ...cfg, scenes, homekit, energy, cameras: cfg.cameras ?? [] }) as HouseConfig;
  }

  const connections: Connection[] = [
    { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
  ];

  // L'ancien bloc `mqtt` devient une connexion à part entière.
  const ancien = cfg.mqtt;
  if (ancien?.url) {
    connections.push({
      id: 'mqtt',
      kind: 'mqtt',
      label: 'Broker MQTT',
      // Si l'ancien driver était le simulateur, la connexion existe mais reste
      // au repos : on n'ouvre pas une socket réseau au nom de l'utilisateur.
      enabled: cfg.driver === 'mqtt',
      settings: {
        url: ancien.url,
        username: ancien.username ?? '',
        password: ancien.password ?? '',
        baseTopic: ancien.baseTopic ?? 'domo',
      },
    });
  }

  const devices = (cfg.devices ?? []).map((d) => {
    const b = d.binding as unknown as AncienBinding | Binding | null;
    if (!b || !('stateTopic' in b)) return { ...d, binding: (b ?? null) as Binding | null };

    const binding: Binding = {
      connectionId: 'mqtt',
      reads: b.stateTopic
        ? [{ source: b.stateTopic, path: b.statePath ?? '', into: champPour(d.type), pipeline: [] }]
        : [],
      writes: b.commandTopic
        ? [{
            on: ecriturePour(d.type),
            target: b.commandTopic,
            payload: '{{valeur}}',
            pipeline: b.payloadOn
              ? [{ op: 'map' as const, table: { true: b.payloadOn, false: b.payloadOff || 'off' } }]
              : [],
            method: 'POST' as const,
          }]
        : [],
    };
    return { ...d, binding };
  });

  const { driver: _d, mqtt: _m, ...reste } = cfg;
  // Ce chemin convertit les bases d'avant le bus d'adaptateurs. Il doit poser
  // TOUTES les sections apparues depuis, sinon il rend une configuration que
  // la validation refuserait — et la maison ne démarrerait pas.
  return {
    ...reste,
    connections,
    devices,
    scenes: cfg.scenes ?? [],
    homekit: cfg.homekit ?? HOMEKIT_DEFAUT,
    energy: cfg.energy ?? ENERGY_DEFAUT,
    cameras: cfg.cameras ?? [],
  } as HouseConfig;
}

function champPour(type: string) {
  switch (type) {
    case 'cover': return 'cover.position' as const;
    case 'dimmer': return 'dim.level' as const;
    case 'thermostat': return 'climate.ambient' as const;
    case 'sensor': return 'sensor.value' as const;
    default: return 'switch.state' as const;
  }
}

function ecriturePour(type: string) {
  switch (type) {
    case 'cover': return 'cover' as const;
    case 'dimmer': return 'dim' as const;
    case 'thermostat': return 'climate' as const;
    default: return 'switch' as const;
  }
}

interface AncienneConfig {
  driver?: 'sim' | 'mqtt';
  mqtt?: { url: string; username?: string; password?: string; baseTopic?: string };
}

interface AncienBinding {
  stateTopic: string;
  commandTopic: string;
  payloadOn?: string;
  payloadOff?: string;
  statePath?: string;
}
