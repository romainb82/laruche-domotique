import type { Capability, CapField, Command, DeviceConfig } from '@domo/shared';
import { BaseAdapter, type AdapterContext } from './adapter.js';
import { poser } from './champs.js';

/**
 * Home Assistant, en moteur d'integration.
 *
 * Le raisonnement est celui du cout. Ecrire un adaptateur par marque de
 * materiel est un travail sans fin, et Home Assistant en a deja deux mille.
 * Plutot que de refaire ce travail, on lui parle comme a un canal de plus, a
 * cote de MQTT, HTTP et Modbus.
 *
 * CE QUI LE DISTINGUE DES AUTRES ADAPTATEURS
 *
 * Les autres demandent de decrire le raccordement : quel topic lire, quel
 * chemin dans la charge utile, quelle transformation appliquer. Ici, rien de
 * tout cela. Home Assistant decrit lui-meme ce qu'il expose : `light.salon`
 * EST une lumiere, `cover.veranda` EST un volet, et leurs attributs sont
 * normalises. L'adaptateur en deduit tout le reste.
 *
 * Un raccordement se resume donc a un identifiant d'entite, pose dans le
 * `source` de la premiere lecture du binding. C'est le seul renseignement
 * qu'on demande, et c'est tout l'interet de passer par Home Assistant.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne remplace pas les autres canaux. Les Shelly et le Zigbee continuent
 * d'arriver en direct par MQTT, pour qu'une panne de Home Assistant n'eteigne
 * qu'une partie de la maison et jamais la totalite.
 */

// -------------------------------------------------------------- le protocole

/** Ce qu'une entite de Home Assistant nous apprend. */
interface Etat {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

interface Message {
  id?: number;
  type: string;
  success?: boolean;
  result?: unknown;
  error?: { message?: string };
  event?: { data?: { entity_id?: string; new_state?: Etat | null } };
}

/** Deux secondes de plus que le delai de connexion d'un socket ordinaire. */
const DELAI_OUVERTURE_MS = 12_000;

/** La reconnexion : on double l'attente a chaque echec, sans depasser 30 s. */
const ATTENTE_MIN_MS = 1_000;
const ATTENTE_MAX_MS = 30_000;

export class HomeAssistantAdapter extends BaseAdapter {
  private socket: WebSocket | null = null;
  private prochainId = 1;
  /** Les promesses en attente de reponse, par identifiant de message. */
  private attentes = new Map<number, { ok: (v: unknown) => void; ko: (e: Error) => void }>();
  private reconnexion: ReturnType<typeof setTimeout> | null = null;
  private attente = ATTENTE_MIN_MS;
  private arrete = false;

  /** entity_id → les equipements qui le reclament. */
  private parEntite = new Map<string, DeviceConfig[]>();

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  // ---------------------------------------------------------------- le cycle

  async attach(devices: DeviceConfig[]): Promise<void> {
    await super.attach(devices);
    this.parEntite.clear();
    for (const d of devices) {
      const entite = entiteDe(d);
      if (!entite) continue;
      const liste = this.parEntite.get(entite) ?? [];
      liste.push(d);
      this.parEntite.set(entite, liste);
    }
  }

  async start(): Promise<void> {
    this.arrete = false;
    await this.ouvrir();
  }

  async stop(): Promise<void> {
    this.arrete = true;
    if (this.reconnexion) clearTimeout(this.reconnexion);
    this.reconnexion = null;
    // On rejette ce qui attendait encore : sans ca, une commande partie juste
    // avant l'arret laisserait une promesse en suspens pour toujours.
    for (const { ko } of this.attentes.values()) ko(new Error('Canal fermé.'));
    this.attentes.clear();
    this.socket?.close();
    this.socket = null;
    this.marquer('disabled', null);
  }

  // ------------------------------------------------------------- la connexion

  private adresseWs(): string {
    const brut = (this.ctx.connection.settings.url ?? '').trim();
    if (!brut) throw new Error("L'adresse de Home Assistant n'est pas renseignée.");
    let u: URL;
    try {
      u = new URL(brut);
    } catch {
      throw new Error(`Adresse illisible : « ${brut} ».`);
    }
    // `http` devient `ws`, `https` devient `wss` : c'est la seule difference
    // entre l'adresse qu'on tape dans un navigateur et celle du socket.
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/api/websocket';
    return u.toString();
  }

  /**
   * Ouvre le socket et franchit la poignee de main.
   *
   * La promesse ne se tient qu'une fois l'authentification ACCEPTEE : le
   * registre doit savoir que le canal est vraiment utilisable, pas seulement
   * que le port repond.
   */
  private ouvrir(): Promise<void> {
    const token = (this.ctx.connection.settings.token ?? '').trim();
    if (!token) throw new Error("Le jeton d'accès de Home Assistant n'est pas renseigné.");

    const adresse = this.adresseWs();
    this.marquer('connecting', null);

    return new Promise<void>((resolve, reject) => {
      let regle = false;
      const socket = new WebSocket(adresse);
      this.socket = socket;

      const minuterie = setTimeout(() => {
        if (regle) return;
        regle = true;
        socket.close();
        reject(new Error(`Home Assistant ne répond pas sur ${adresse}.`));
      }, DELAI_OUVERTURE_MS);

      const fini = (e?: Error) => {
        if (regle) return;
        regle = true;
        clearTimeout(minuterie);
        if (e) reject(e);
        else resolve();
      };

      socket.addEventListener('message', (ev: MessageEvent) => {
        let m: Message;
        try {
          m = JSON.parse(String(ev.data)) as Message;
        } catch {
          return;
        }

        if (m.type === 'auth_required') {
          socket.send(JSON.stringify({ type: 'auth', access_token: token }));
          return;
        }

        if (m.type === 'auth_invalid') {
          // Message explicite : un jeton refuse est l'erreur la plus frequente,
          // et « connexion fermee » n'aiderait personne a la corriger.
          fini(new Error('Jeton refusé par Home Assistant. Créez-en un nouveau dans votre profil.'));
          socket.close();
          return;
        }

        if (m.type === 'auth_ok') {
          this.attente = ATTENTE_MIN_MS;
          this.marquer('connected', null);
          void this.amorcer().then(
            () => fini(),
            (e: Error) => fini(e),
          );
          return;
        }

        this.recevoir(m);
      });

      socket.addEventListener('error', () => {
        // L'evenement `error` d'un WebSocket ne porte jamais de detail
        // exploitable : on donne l'adresse, qui est ce qu'on peut verifier.
        fini(new Error(`Connexion impossible à ${adresse}.`));
      });

      socket.addEventListener('close', () => {
        fini(new Error('Connexion à Home Assistant fermée.'));
        this.perdue();
      });
    });
  }

  /** L'instantane, puis l'abonnement au direct. */
  private async amorcer(): Promise<void> {
    const etats = (await this.demander({ type: 'get_states' })) as Etat[];
    for (const e of etats) this.traiter(e);
    await this.demander({ type: 'subscribe_events', event_type: 'state_changed' });
  }

  private perdue(): void {
    this.socket = null;
    for (const { ko } of this.attentes.values()) ko(new Error('Connexion perdue.'));
    this.attentes.clear();

    if (this.arrete) return;
    this.marquer('error', 'Connexion perdue, reprise en cours.');

    // On double l'attente a chaque echec : un serveur qui redemarre met
    // quelques secondes, un serveur eteint met des heures, et marteler sa
    // porte toutes les secondes n'avance a rien.
    this.reconnexion = setTimeout(() => {
      this.ouvrir().catch((e: Error) => {
        this.marquer('error', e.message);
        this.perdue();
      });
    }, this.attente);
    this.attente = Math.min(this.attente * 2, ATTENTE_MAX_MS);
  }

  // ------------------------------------------------------------ les echanges

  /** Envoie un message et attend sa reponse. */
  private demander(corps: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Home Assistant est injoignable.'));

    const id = this.prochainId++;
    return new Promise((ok, ko) => {
      this.attentes.set(id, { ok, ko });
      socket.send(JSON.stringify({ ...corps, id }));
      // Un message sans reponse ne doit pas retenir une promesse pour
      // toujours : dix secondes, puis on abandonne.
      setTimeout(() => {
        if (!this.attentes.delete(id)) return;
        ko(new Error("Home Assistant n'a pas répondu."));
      }, 10_000);
    });
  }

  private recevoir(m: Message): void {
    if (m.type === 'result' && typeof m.id === 'number') {
      const attente = this.attentes.get(m.id);
      if (!attente) return;
      this.attentes.delete(m.id);
      if (m.success) attente.ok(m.result);
      else attente.ko(new Error(m.error?.message ?? 'Requête refusée.'));
      return;
    }

    if (m.type === 'event') {
      const etat = m.event?.data?.new_state;
      // `new_state` vaut `null` quand une entite disparait de Home Assistant.
      // On ne traduit rien : l'equipement passera en `stale` tout seul, ce qui
      // est exactement ce qu'il faut dire.
      if (etat) this.traiter(etat);
    }
  }

  // ----------------------------------------------------------- la traduction

  private traiter(etat: Etat): void {
    const cibles = this.parEntite.get(etat.entity_id);

    if (!cibles?.length) {
      // Personne ne reclame cette entite : c'est un candidat a l'adoption.
      // C'est ce qui fait apparaitre les integrations de Home Assistant dans
      // l'ecran Materiel, sans une ligne d'interface a ecrire.
      const nom = String(etat.attributes.friendly_name ?? etat.entity_id);
      this.noterCandidat(etat.entity_id, `${nom} : ${etat.state}`, cheminsDe(etat));
      return;
    }

    this.dernier = new Date().toISOString();
    for (const device of cibles) {
      const caps = traduire(etat, device);
      if (caps.length) this.ctx.emit({ deviceId: device.id, caps });
    }
  }

  // ----------------------------------------------------------- les commandes

  async command(device: DeviceConfig, command: Command): Promise<void> {
    const entite = entiteDe(device);
    if (!entite) throw new Error(`« ${device.label} » n'a pas d'entité Home Assistant.`);

    const appel = serviceDe(entite, command);
    if (!appel) throw new Error('Home Assistant ne sait pas traiter cette commande.');

    await this.demander({
      type: 'call_service',
      domain: appel.domain,
      service: appel.service,
      target: { entity_id: entite },
      service_data: appel.data,
    });

    // Volontairement rien d'autre : l'etat ne vient PAS de cet appel reussi,
    // il viendra de l'evenement `state_changed` que Home Assistant emettra
    // quand le materiel aura vraiment bouge. C'est la regle d'or du projet.
  }
}

// ================================================================ les regles

/** L'identifiant d'entite d'un equipement, pris dans son raccordement. */
function entiteDe(d: DeviceConfig): string | null {
  const brut = d.binding?.reads?.[0]?.source?.trim();
  return brut || null;
}

/**
 * Quel attribut d'une entite meteo nourrit quelle grandeur du modele.
 *
 * Seules celles que notre modele connait : une entite meteo porte aussi la
 * pression et l'indice UV, que le domaine ne sait pas representer aujourd'hui.
 */
const ATTRIBUT_METEO: Record<string, string | undefined> = {
  temperature: 'temperature',
  humidity: 'humidity',
};

/** `light.salon_general` → `light`. */
const domaineDe = (entite: string) => entite.split('.')[0] ?? '';

/**
 * Ce que Home Assistant raconte, traduit en capacites du modele.
 *
 * Chaque domaine a sa correspondance, et elles sont toutes documentees chez
 * eux. Ce qui n'est pas liste ici est ignore : mieux vaut un equipement muet
 * qu'un etat invente.
 */
function traduire(etat: Etat, device: DeviceConfig): Capability[] {
  const domaine = domaineDe(etat.entity_id);
  const a = etat.attributes;
  let caps: Capability[] = [];

  const met = (champ: CapField, v: unknown) => {
    caps = poser(caps, device, champ, v);
  };

  switch (domaine) {
    case 'light': {
      met('switch.state', etat.state === 'on');
      // Home Assistant compte la luminosite de 0 a 255, nous de 0 a 100.
      // L'arrondi est choisi explicitement : sans lui, un aller-retour fait
      // reculer le curseur d'un point apres chaque reglage.
      if (typeof a.brightness === 'number')
        met('dim.level', Math.round((a.brightness / 255) * 100));
      break;
    }

    case 'switch':
    case 'input_boolean':
    case 'fan':
      met('switch.state', etat.state === 'on');
      break;

    case 'cover': {
      if (typeof a.current_position === 'number') met('cover.position', a.current_position);
      // Pas de position rapportee : on deduit du mot d'etat, ce qui donne au
      // moins ouvert ou ferme, a defaut d'un pourcentage.
      else if (etat.state === 'open') met('cover.position', 100);
      else if (etat.state === 'closed') met('cover.position', 0);
      // `up` / `down` / `null`, et pas un booleen : le modele veut savoir
      // DANS QUEL SENS le volet bouge, pour dessiner la bonne fleche. Un
      // booleen y perdait l'information et retombait sur `null`.
      met(
        'cover.moving',
        etat.state === 'opening' ? 'up' : etat.state === 'closing' ? 'down' : null,
      );
      break;
    }

    case 'climate': {
      if (typeof a.current_temperature === 'number') met('climate.ambient', a.current_temperature);
      if (typeof a.temperature === 'number') met('climate.setpoint', a.temperature);
      // `hvac_action` dit si l'appareil chauffe EN CE MOMENT, ce que `state`
      // ne dit pas : `heat` signifie seulement « en mode chauffage ».
      if (typeof a.hvac_action === 'string')
        met('climate.demand', a.hvac_action === 'heating' || a.hvac_action === 'cooling');
      break;
    }

    case 'sensor': {
      const v = Number(etat.state);
      if (Number.isFinite(v)) met('sensor.value', v);
      break;
    }

    case 'weather': {
      // Une entite meteo porte PLUSIEURS grandeurs dans ses attributs, et son
      // etat est un mot (« cloudy »), pas un nombre. On choisit donc l'attribut
      // d'apres la metrique de l'equipement qui la reclame.
      //
      // C'est l'integration que Home Assistant installe d'office : elle donne
      // la temperature exterieure sans acheter ni poser quoi que ce soit.
      const champ = ATTRIBUT_METEO[device.metric ?? ''];
      const v = champ ? a[champ] : undefined;
      if (typeof v === 'number') met('sensor.value', v);
      break;
    }

    case 'binary_sensor':
      // Un contact ouvert vaut 1, ferme vaut 0 : c'est la convention du
      // modele, et la tuile de capteur l'affiche deja ainsi.
      met('sensor.value', etat.state === 'on' ? 1 : 0);
      break;

    default:
      break;
  }

  return caps;
}

/** La commande du modele, traduite en appel de service. */
function serviceDe(
  entite: string,
  c: Command,
): { domain: string; service: string; data: Record<string, unknown> } | null {
  const domain = domaineDe(entite);

  switch (c.kind) {
    case 'switch':
      return { domain, service: c.state ? 'turn_on' : 'turn_off', data: {} };

    case 'dim':
      // `brightness_pct` et non `brightness` : Home Assistant fait lui-meme la
      // conversion vers 0-255, et on evite un arrondi de plus.
      return c.level <= 0
        ? { domain: 'light', service: 'turn_off', data: {} }
        : { domain: 'light', service: 'turn_on', data: { brightness_pct: c.level } };

    case 'cover':
      // Les butees passent par les services dedies : tous les volets ne savent
      // pas se positionner au pourcentage, mais tous savent s'ouvrir et se
      // fermer completement.
      if (c.position <= 0) return { domain: 'cover', service: 'close_cover', data: {} };
      if (c.position >= 100) return { domain: 'cover', service: 'open_cover', data: {} };
      return { domain: 'cover', service: 'set_cover_position', data: { position: c.position } };

    case 'cover-stop':
      // Oubliee a la premiere ecriture : le modele sait arreter un volet en
      // pleine course, et Home Assistant aussi.
      return { domain: 'cover', service: 'stop_cover', data: {} };

    case 'climate':
      return { domain: 'climate', service: 'set_temperature', data: { temperature: c.setpoint } };

    default:
      return null;
  }
}

/**
 * Ce qu'on montre d'une entite non adoptee, dans l'ecran Materiel.
 *
 * On expose l'etat et les attributs qui portent une valeur, pour que la
 * personne reconnaisse de quoi il s'agit sans ouvrir Home Assistant a cote.
 */
function cheminsDe(etat: Etat): { path: string; sample: string }[] {
  const sorties = [{ path: 'state', sample: etat.state }];
  for (const [cle, v] of Object.entries(etat.attributes)) {
    if (v === null || typeof v === 'object') continue;
    sorties.push({ path: `attributes.${cle}`, sample: String(v).slice(0, 40) });
    if (sorties.length >= 10) break;
  }
  return sorties;
}
