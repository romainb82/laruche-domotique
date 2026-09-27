import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Accessory, Bridge, Characteristic, HAPStorage, Service, uuid } from 'hap-nodejs';
import {
  findCap, type Command, type DeviceConfig, type DeviceState, type HouseConfig,
} from '@domo/shared';
import type { StateHub } from './state.js';

/**
 * Deux valeurs du protocole, écrites en clair.
 *
 * `Categories` et `HAPStatus` sont déclarées par la bibliothèque comme des
 * énumérations constantes, que le compilateur refuse d'inliner sous
 * `verbatimModuleSyntax`. Les recopier ici vaut mieux qu'un cast qui masque
 * le type : ce sont des constantes du protocole HomeKit, fixées par Apple, et
 * elles ne bougeront pas.
 */
const CATEGORIE_PONT = 2;
const PANNE_DE_COMMUNICATION = -70402;

/**
 * Le dossier de stockage ne se fixe qu'UNE fois pour tout le processus.
 *
 * La bibliothèque refuse un second appel, et le pont mourait donc à sa
 * deuxième ouverture — soit dès le premier changement de réglage, ce qui est
 * exactement le moment où on l'ouvre pour de bon.
 */
let stockageFixe = false;
function fixerStockage(dossier: string): void {
  if (stockageFixe) return;
  mkdirSync(dossier, { recursive: true });
  HAPStorage.setCustomStoragePath(dossier);
  stockageFixe = true;
}

/**
 * Le pont HomeKit.
 *
 * Il expose la maison à l'app Maison d'Apple — donc à Siri, au widget, aux
 * automatisations d'Apple et aux autres membres du foyer — sans rien changer
 * au modèle. Le pont est un CLIENT du cerveau, exactement comme l'interface
 * web : il lit l'état, il transmet les commandes, et il n'invente rien.
 *
 * Les deux règles tiennent, et c'est le point délicat :
 *
 * 1. **L'état vient du matériel.** Quand Siri allume une lampe, on envoie la
 *    commande et on ne touche PAS à la caractéristique. Elle changera quand le
 *    module aura confirmé, par le même chemin que l'interface web. C'est ce
 *    qui évite qu'iOS affiche « allumé » sur une ampoule grillée.
 * 2. **Trois états visibles.** HomeKit n'a pas de « en attente », mais il a un
 *    « pas de réponse » : un équipement injoignable fait répondre une erreur de
 *    communication, et l'app Maison le grise d'elle-même. Mentir en rendant la
 *    dernière valeur connue serait pire que de ne rien dire.
 *
 * Ce qui n'est pas exposé, et pourquoi : le pH, le redox et la puissance n'ont
 * aucun service HomeKit correspondant. Les faire passer pour autre chose — une
 * température, un capteur de lumière — donnerait des relevés absurdes dans
 * l'app Maison. Ils restent dans l'app du projet, qui sait les afficher.
 */
export class PontHomeKit {
  private bridge: Bridge | null = null;
  private accessoires = new Map<string, Accessory>();
  private publie = false;
  private erreur: string | null = null;
  /** Les équipements laissés de côté, pour pouvoir le dire plutôt que le taire. */
  private ecartes: { label: string; raison: string }[] = [];

  constructor(
    private hub: StateHub,
    private dossier: string,
  ) {}

  // ------------------------------------------------------------------ cycle

  async start(config: HouseConfig): Promise<void> {
    await this.stop();
    this.erreur = null;
    this.ecartes = [];

    const reglages = config.homekit;
    if (!reglages?.enabled) return;

    try {
      fixerStockage(this.dossier);

      const nom = reglages.name?.trim() || 'Maison';
      this.bridge = new Bridge(nom, uuid.generate(`domo.pont.${config.house.name}`));

      for (const device of config.devices) {
        const accessoire = this.fabriquer(device);
        if (!accessoire) continue;
        this.accessoires.set(device.id, accessoire);
        this.bridge.addBridgedAccessory(accessoire);
      }

      await this.bridge.publish({
        // L'identifiant doit être STABLE : il est la clé sous laquelle iOS
        // retient l'association. Le dériver du nom de la maison permet de
        // redémarrer, migrer la base, changer de machine, sans réassocier.
        username: identifiantStable(config.house.name),
        pincode: reglages.pin,
        port: reglages.port || 51826,
        category: CATEGORIE_PONT,
        addIdentifyingMaterial: true,
      });
      this.publie = true;

      // L'état actuel est poussé tout de suite : sans ça l'app Maison
      // afficherait des zéros jusqu'au premier changement.
      for (const etat of this.hub.snapshot()) this.pousser(etat);
    } catch (e) {
      this.erreur = (e as Error).message;
      this.bridge = null;
      this.publie = false;
      throw new Error(`Pont HomeKit : ${this.erreur}`);
    }
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      try {
        await this.bridge.unpublish();
      } catch {
        // Un pont qui refuse de se retirer proprement ne doit pas empêcher le
        // serveur de s'arrêter.
      }
      this.bridge.removeAllListeners();
    }
    this.bridge = null;
    this.accessoires.clear();
    this.publie = false;
  }

  /** Ce que l'interface affiche : ouvert ou non, et ce qui a été laissé dehors. */
  etat(config: HouseConfig): {
    enabled: boolean;
    published: boolean;
    error: string | null;
    exposes: number;
    skipped: { label: string; raison: string }[];
    pin: string | null;
  } {
    return {
      enabled: !!config.homekit?.enabled,
      published: this.publie,
      error: this.erreur,
      exposes: this.accessoires.size,
      skipped: this.ecartes,
      // Le code ne sort que si le pont est effectivement ouvert : l'exposer en
      // permanence en ferait une clé qui traîne pour rien.
      pin: this.publie ? (config.homekit?.pin ?? null) : null,
    };
  }

  // ------------------------------------------------- l'état vient du matériel

  /**
   * Pousse un état vers HomeKit.
   *
   * Appelé par le cerveau à chaque nouvelle du matériel, jamais au moment du
   * clic. C'est toute la première règle.
   */
  pousser(etat: DeviceState): void {
    const accessoire = this.accessoires.get(etat.id);
    if (!accessoire || !this.publie) return;

    // Un équipement injoignable ne reçoit pas de valeur : on laisse l'app
    // Maison dire « pas de réponse » plutôt que d'afficher un état périmé.
    if (etat.health === 'offline') return;

    const dire = (service: Service | undefined, carac: unknown, valeur: unknown) => {
      if (!service || valeur === undefined) return;
      service.getCharacteristic(carac as never).updateValue(valeur as never);
    };

    const interrupteur = findCap(etat, 'switch');
    const variateur = findCap(etat, 'dim');
    const volet = findCap(etat, 'cover');
    const climat = findCap(etat, 'climate');
    const mesure = findCap(etat, 'sensor');

    const lampe = accessoire.getService(Service.Lightbulb);
    if (lampe && interrupteur) {
      dire(lampe, Characteristic.On, interrupteur.state);
      if (variateur) dire(lampe, Characteristic.Brightness, Math.round(variateur.level));
    }

    const store = accessoire.getService(Service.WindowCovering);
    if (store && volet) {
      const position = Math.round(volet.position);
      dire(store, Characteristic.CurrentPosition, position);
      dire(store, Characteristic.TargetPosition, position);
      dire(store, Characteristic.PositionState,
        volet.moving === 'up' ? Characteristic.PositionState.INCREASING
          : volet.moving === 'down' ? Characteristic.PositionState.DECREASING
            : Characteristic.PositionState.STOPPED);
    }

    const thermostat = accessoire.getService(Service.Thermostat);
    if (thermostat && climat) {
      dire(thermostat, Characteristic.CurrentTemperature, climat.ambient);
      dire(thermostat, Characteristic.TargetTemperature, borne(climat.setpoint, 10, 38));
      dire(thermostat, Characteristic.CurrentHeatingCoolingState,
        climat.demand ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF);
    }

    if (mesure) {
      dire(accessoire.getService(Service.TemperatureSensor), Characteristic.CurrentTemperature, mesure.value);
      dire(accessoire.getService(Service.HumiditySensor), Characteristic.CurrentRelativeHumidity, borne(mesure.value, 0, 100));
      dire(accessoire.getService(Service.LightSensor), Characteristic.CurrentAmbientLightLevel, Math.max(0.0001, mesure.value));
      dire(accessoire.getService(Service.ContactSensor), Characteristic.ContactSensorState,
        mesure.value > 0 ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED);
    }
  }

  // --------------------------------------------------------- la fabrication

  private fabriquer(device: DeviceConfig): Accessory | null {
    const accessoire = new Accessory(device.label, uuid.generate(`domo.${device.id}`));

    accessoire.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Domotique')
      .setCharacteristic(Characteristic.Model, device.type)
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    switch (device.type) {
      case 'light':
      case 'dimmer':
        this.monterLampe(accessoire, device);
        return accessoire;
      case 'cover':
        this.monterVolet(accessoire, device);
        return accessoire;
      case 'thermostat':
        this.monterThermostat(accessoire, device);
        return accessoire;
      case 'sensor':
        return this.monterCapteur(accessoire, device) ? accessoire : null;
      default:
        this.ecartes.push({ label: device.label, raison: `type « ${device.type} » sans équivalent HomeKit` });
        return null;
    }
  }

  private monterLampe(a: Accessory, device: DeviceConfig): void {
    const service = a.addService(Service.Lightbulb, device.label);

    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.lire(device.id, (e) => findCap(e, 'switch')?.state ?? false))
      // On transmet et on s'arrête là : la caractéristique ne bougera qu'au
      // retour du matériel. C'est exactement la règle de l'interface web.
      .onSet((v) => this.envoyer(device.id, { kind: 'switch', state: !!v }));

    if (device.type !== 'dimmer') return;

    service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.lire(device.id, (e) => Math.round(findCap(e, 'dim')?.level ?? 0)))
      .onSet((v) => {
        const niveau = Number(v);
        // Zéro depuis HomeKit veut dire « éteins », pas « règle à 0 % ».
        if (niveau <= 0) return this.envoyer(device.id, { kind: 'switch', state: false });
        return this.envoyer(device.id, { kind: 'dim', level: niveau });
      });
  }

  private monterVolet(a: Accessory, device: DeviceConfig): void {
    const service = a.addService(Service.WindowCovering, device.label);
    const position = (e: DeviceState) => Math.round(findCap(e, 'cover')?.position ?? 0);

    service.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.lire(device.id, position));

    service.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.lire(device.id, position))
      .onSet((v) => this.envoyer(device.id, { kind: 'cover', position: Number(v) }));

    service.getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.lire(device.id, (e) => {
        const c = findCap(e, 'cover');
        return c?.moving === 'up' ? Characteristic.PositionState.INCREASING
          : c?.moving === 'down' ? Characteristic.PositionState.DECREASING
            : Characteristic.PositionState.STOPPED;
      }));
  }

  private monterThermostat(a: Accessory, device: DeviceConfig): void {
    const service = a.addService(Service.Thermostat, device.label);

    service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.lire(device.id, (e) => findCap(e, 'climate')?.ambient ?? 20));

    service.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => this.lire(device.id, (e) => borne(findCap(e, 'climate')?.setpoint ?? 20, 10, 38)))
      .onSet((v) => this.envoyer(device.id, { kind: 'climate', setpoint: Number(v) }));

    service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.lire(device.id, (e) =>
        findCap(e, 'climate')?.demand
          ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF));

    // La maison n'a que du chauffage : proposer « refroidir » dans l'app Maison
    // serait un bouton qui ne fait rien.
    const cible = service.getCharacteristic(Characteristic.TargetHeatingCoolingState);
    cible.setProps({
      validValues: [
        Characteristic.TargetHeatingCoolingState.OFF,
        Characteristic.TargetHeatingCoolingState.HEAT,
      ],
    });
    cible.onGet(() => Characteristic.TargetHeatingCoolingState.HEAT);
  }

  /** Rend faux si la grandeur n'a pas d'équivalent HomeKit — et le dit. */
  private monterCapteur(a: Accessory, device: DeviceConfig): boolean {
    const valeur = (e: DeviceState) => findCap(e, 'sensor')?.value ?? 0;

    switch (device.metric) {
      case 'temperature':
        a.addService(Service.TemperatureSensor, device.label)
          .getCharacteristic(Characteristic.CurrentTemperature)
          .onGet(() => this.lire(device.id, valeur));
        return true;
      case 'humidity':
        a.addService(Service.HumiditySensor, device.label)
          .getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .onGet(() => this.lire(device.id, (e) => borne(valeur(e), 0, 100)));
        return true;
      case 'lux':
        a.addService(Service.LightSensor, device.label)
          .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
          // HomeKit refuse zéro lux : la nuit noire vaut 0,0001.
          .onGet(() => this.lire(device.id, (e) => Math.max(0.0001, valeur(e))));
        return true;
      case 'contact':
        a.addService(Service.ContactSensor, device.label)
          .getCharacteristic(Characteristic.ContactSensorState)
          .onGet(() => this.lire(device.id, (e) =>
            valeur(e) > 0
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED));
        return true;
      default:
        // pH, redox, puissance, batterie : aucun service HomeKit ne les porte.
        // Les déguiser en température donnerait des relevés absurdes dans l'app
        // Maison. On les laisse à l'application du projet, et on le dit.
        this.ecartes.push({
          label: device.label,
          raison: `la grandeur « ${device.metric ?? 'inconnue'} » n’existe pas dans HomeKit`,
        });
        return false;
    }
  }

  // ------------------------------------------------------------------ ponts

  /**
   * Lit l'état pour HomeKit.
   *
   * Un équipement injoignable rend une erreur de communication plutôt qu'une
   * vieille valeur : l'app Maison affiche alors « pas de réponse », ce qui est
   * la vérité. C'est la troisième couleur, dans le vocabulaire d'Apple.
   */
  private lire<T>(deviceId: string, extraire: (etat: DeviceState) => T): T {
    const etat = this.hub.get(deviceId);
    if (!etat || etat.health === 'offline')
      throw new Error(String(PANNE_DE_COMMUNICATION));
    return extraire(etat);
  }

  /** Transmet une commande. Ne touche à aucune caractéristique : c'est la règle. */
  private async envoyer(deviceId: string, command: Command): Promise<void> {
    try {
      await this.hub.command(deviceId, command, 'ui');
    } catch {
      // Le refus remonte à HomeKit comme une panne de communication : Siri dit
      // alors que ça n'a pas marché, au lieu de laisser croire que si.
      throw new Error(String(PANNE_DE_COMMUNICATION));
    }
  }
}

/**
 * L'identifiant du pont, dérivé du nom de la maison.
 *
 * Il doit rester stable : iOS s'en sert comme clé de l'association. Un
 * identifiant tiré au sort à chaque démarrage obligerait à réassocier la maison
 * après chaque redémarrage du serveur.
 */
function identifiantStable(nomMaison: string): string {
  const h = createHash('sha256').update(`domo.pont.${nomMaison}`).digest('hex');
  const octets = [0, 2, 4, 6, 8, 10].map((i) => h.slice(i, i + 2).toUpperCase());
  // Bit « administré localement » : l'adresse ne doit pas pouvoir entrer en
  // collision avec celle d'un vrai fabricant.
  octets[0] = (parseInt(octets[0]!, 16) | 0x02).toString(16).padStart(2, '0').toUpperCase();
  return octets.join(':');
}

const borne = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
