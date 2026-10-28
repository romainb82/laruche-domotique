import {
  applyPipeline, formatModbusAddress, modbusWords, parseModbusAddress,
  type Capability, type CapField, type Command, type DeviceConfig,
  type ModbusAddress, type ReadSpec,
} from '@domo/shared';
import { BaseAdapter, type AdapterContext } from './adapter.js';
import { poser } from './champs.js';
import { valeurDe } from './mqtt.js';
import {
  decoder, encoder, estRefusModbus, lisible, MAX_MOTS, ModbusTcpClient,
} from './modbus-tcp.js';

/**
 * Le canal Modbus TCP.
 *
 * Le protocole du matériel technique : pompes à chaleur, centrales de
 * traitement d'air, compteurs, onduleurs. Rien de ce monde-là ne parle MQTT.
 *
 * Deux différences de fond avec les autres canaux, qui expliquent la forme de
 * ce fichier :
 *
 * 1. **Une adresse Modbus n'a aucun sens intrinsèque.** `holding:100` peut
 *    être une température comme un code d'alarme : seule la documentation du
 *    fabricant le dit. D'où la chaîne de transformations, la même que partout
 *    ailleurs, qui fait le reste du travail.
 * 2. **Aucune découverte n'existe.** Un équipement Modbus ne sait pas dire ce
 *    qu'il contient. On offre donc à la place un BALAYAGE : on lit une plage
 *    de registres et on montre ce qui s'y trouve, en direct. Ce n'est pas de
 *    la découverte, mais à l'usage ça revient au même : on voit quelle case
 *    bouge quand on touche à la machine.
 */
export class ModbusAdapter extends BaseAdapter {
  private client: ModbusTcpClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private occupe = false;

  private host: string;
  private port: number;
  private unitId: number;

  /** Les lectures déclarées, déjà analysées : une adresse fautive se voit au démarrage. */
  private lectures: { device: DeviceConfig; read: ReadSpec; adresse: ModbusAddress }[] = [];
  /** Les blocs à demander, regroupés pour limiter le nombre d'allers-retours. */
  private blocs: { table: ModbusAddress['table']; debut: number; taille: number }[] = [];

  constructor(ctx: AdapterContext) {
    super(ctx);
    const s = ctx.connection.settings;
    this.host = (s.host ?? '').trim();
    this.port = Number(s.port) || 502;
    this.unitId = Number.isFinite(Number(s.unitId)) ? Number(s.unitId) : 1;
  }

  async start(): Promise<void> {
    if (!this.host) throw new Error("Adresse de l'équipement manquante.");
    this.marquer('connecting');

    this.client = new ModbusTcpClient(this.host, this.port, this.unitId);
    await this.client.connect();

    // On sonde avant de se déclarer prêt, comme le canal HTTP. Ouvrir une
    // socket ne prouve rien : beaucoup de choses écoutent sur un port. Ce qui
    // prouve qu'on parle à du Modbus, c'est une RÉPONSE : un refus en est une.
    await this.sonder();

    const periode = Math.max(2, Number(this.ctx.connection.settings.pollSeconds) || 10) * 1000;
    this.timer = setInterval(() => void this.interroger(), periode);
    this.timer.unref?.();

    await this.interroger();
    if (this.etat === 'connecting') this.marquer('connected');
  }

  /**
   * Vérifie que quelque chose de modbusien répond.
   *
   * Un refus (« ce registre n'existe pas ») est un succès : il prouve que
   * l'équipement a compris la question. Seul le silence, ou une panne de
   * transport, est un échec.
   */
  private async sonder(): Promise<void> {
    const premiere = this.blocs[0];
    try {
      if (premiere) await this.lireBloc(premiere.table, premiere.debut, premiere.taille);
      else await this.client!.readWords('holding', 0, 1);
    } catch (e) {
      if (estRefusModbus(e)) return;
      throw new Error(lisible(e as Error, `${this.host}:${this.port}`));
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client?.close();
    this.client = null;
    this.marquer('disabled');
  }

  async attach(devices: DeviceConfig[]): Promise<void> {
    await super.attach(devices);
    this.lectures = [];

    for (const d of devices) {
      for (const read of d.binding?.reads ?? []) {
        if (!read.source) continue;
        const analyse = parseModbusAddress(read.source);
        if (!analyse.ok) {
          // Une adresse fautive est dite tout de suite, et n'empêche pas les
          // autres de fonctionner. Silencieusement ignorée, elle produirait un
          // équipement éternellement muet sans que rien ne l'explique.
          this.ctx.warn(`[${this.ctx.connection.label}] « ${d.label} » : ${analyse.error}`);
          continue;
        }
        this.lectures.push({ device: d, read, adresse: analyse.address });
      }
    }
    this.blocs = this.regrouper();
  }

  /**
   * Regroupe les lectures en blocs contigus.
   *
   * Une pompe à chaleur expose souvent vingt registres qui se suivent. Les
   * demander un par un, c'est vingt allers-retours là où un seul suffit, et
   * sur une liaison série derrière une passerelle, ça se compte en secondes.
   *
   * Les trous sont tolérés jusqu'à huit registres : au-delà, lire le vide
   * coûte plus cher qu'une seconde requête.
   */
  private regrouper(): { table: ModbusAddress['table']; debut: number; taille: number }[] {
    const TROU_MAX = 8;
    const sortie: { table: ModbusAddress['table']; debut: number; taille: number }[] = [];

    const parTable = new Map<ModbusAddress['table'], number[]>();
    for (const l of this.lectures) {
      const bit = l.adresse.table === 'coil' || l.adresse.table === 'discrete';
      const longueur = bit ? 1 : modbusWords(l.adresse.type);
      const liste = parTable.get(l.adresse.table) ?? [];
      for (let i = 0; i < longueur; i++) liste.push(l.adresse.offset + i);
      parTable.set(l.adresse.table, liste);
    }

    for (const [table, brutes] of parTable) {
      const adresses = [...new Set(brutes)].sort((a, b) => a - b);
      if (!adresses.length) continue;
      const bit = table === 'coil' || table === 'discrete';
      const max = bit ? 256 : MAX_MOTS;

      let debut = adresses[0]!;
      let fin = debut;
      for (const a of adresses.slice(1)) {
        if (a - fin <= TROU_MAX && a - debut + 1 <= max) { fin = a; continue; }
        sortie.push({ table, debut, taille: fin - debut + 1 });
        debut = a;
        fin = a;
      }
      sortie.push({ table, debut, taille: fin - debut + 1 });
    }
    return sortie;
  }

  async command(device: DeviceConfig, command: Command): Promise<void> {
    const writes = (device.binding?.writes ?? []).filter((w) => w.on === command.kind);
    if (!writes.length)
      throw new Error(`« ${device.label} » n'a pas d'écriture déclarée pour cette commande.`);
    if (!this.client?.connecte) throw new Error(`${this.host}:${this.port} n'est pas connecté.`);

    for (const w of writes) {
      const analyse = parseModbusAddress(w.target);
      if (!analyse.ok) throw new Error(`« ${device.label} » : ${analyse.error}`);
      const { table, offset, type } = analyse.address;

      if (table === 'discrete' || table === 'input')
        throw new Error(
          `« ${device.label} » écrit sur ${w.target}, or cette table est en lecture seule. ` +
            'Seules une bobine ou un registre de maintien acceptent une écriture.',
        );

      const brut = valeurDe(command);
      const transforme = w.pipeline.length ? applyPipeline(brut, w.pipeline) : brut;

      if (table === 'coil') {
        await this.client.writeCoil(offset, estVrai(transforme));
        continue;
      }
      const n = Number(typeof transforme === 'boolean' ? (transforme ? 1 : 0) : transforme);
      if (!Number.isFinite(n))
        throw new Error(`« ${device.label} » : « ${String(transforme)} » n'est pas un nombre écrivable.`);
      await this.client.writeWords(offset, encoder(n, type));
    }
  }

  // ------------------------------------------------------------ interrogation

  private async interroger(): Promise<void> {
    // Un cycle lent ne doit pas se chevaucher avec le suivant : le protocole
    // est sérialisé, et empiler les cycles ne ferait qu'allonger la file.
    if (this.occupe) return;
    this.occupe = true;
    try {
      if (!this.client?.connecte) await this.rebrancher();
      if (!this.client?.connecte) return;

      await this.lireLesBlocs();
      await this.balayer();
    } finally {
      this.occupe = false;
    }
  }

  private async rebrancher(): Promise<void> {
    try {
      this.client?.close();
      this.client = new ModbusTcpClient(this.host, this.port, this.unitId);
      await this.client.connect();
      this.marquer('connected');
    } catch (e) {
      this.client = null;
      this.marquer('error', lisible(e as Error, `${this.host}:${this.port}`));
    }
  }

  private async lireLesBlocs(): Promise<void> {
    // Les capacités s'accumulent sur TOUT le cycle, pas bloc par bloc.
    //
    // Un thermostat lit sa consigne et son ambiante dans les registres de
    // maintien, mais sa demande de chauffe dans les entrées TOR : deux tables,
    // donc deux blocs. Émettre après chaque bloc envoyait une capacité
    // « climat » complète à chaque fois, et celle du second bloc, reconstruite
    // à partir de rien, écrasait la consigne par sa valeur par défaut. Le
    // thermostat affichait 20 °C quoi que dise la machine.
    const parEquipement = new Map<string, { device: DeviceConfig; caps: Capability[] }>();

    for (const bloc of this.blocs) {
      let valeurs: (number | boolean)[];
      try {
        valeurs = await this.lireBloc(bloc.table, bloc.debut, bloc.taille);
        this.marquer('connected');
      } catch (e) {
        this.marquer('error', lisible(e as Error, `${bloc.table}:${bloc.debut}`));
        continue;
      }

      for (const l of this.lectures) {
        if (l.adresse.table !== bloc.table) continue;
        const i = l.adresse.offset - bloc.debut;
        if (i < 0 || i >= valeurs.length) continue;

        const bit = bloc.table === 'coil' || bloc.table === 'discrete';
        const brut = bit
          ? valeurs[i]
          : decoder(valeurs.slice(i, i + modbusWords(l.adresse.type)) as number[], l.adresse.type);
        if (brut === undefined) continue;

        const valeur = l.read.pipeline.length ? applyPipeline(brut, l.read.pipeline) : brut;
        if (valeur === undefined) continue;

        const e = parEquipement.get(l.device.id) ?? { device: l.device, caps: this.ctx.courant?.(l.device.id) ?? [] };
        e.caps = poser(e.caps, l.device, l.read.into as CapField, valeur);
        parEquipement.set(l.device.id, e);
      }
    }

    for (const { device, caps } of parEquipement.values()) {
      if (caps.length) this.ctx.emit({ deviceId: device.id, caps });
    }
  }

  private async lireBloc(
    table: ModbusAddress['table'],
    debut: number,
    taille: number,
  ): Promise<(number | boolean)[]> {
    if (table === 'coil' || table === 'discrete') return this.client!.readBits(table, debut, taille);
    return this.client!.readWords(table, debut, taille);
  }

  /**
   * Le balayage : à défaut de découverte, on montre ce qu'il y a.
   *
   * Éteint tant qu'on ne l'a pas demandé : lire cinquante registres toutes les
   * dix secondes sur un équipement qu'on ne connaît pas est une impolitesse
   * qu'on ne s'autorise pas par défaut.
   */
  private async balayer(): Promise<void> {
    const s = this.ctx.connection.settings;
    const demande = Number(s.scanCount) || 0;
    if (demande <= 0) return;

    const table = (s.scanTable ?? 'holding') as ModbusAddress['table'];
    const debut = Number(s.scanFrom) || 0;
    const bit = table === 'coil' || table === 'discrete';
    const taille = Math.min(demande, bit ? 128 : 64);

    let valeurs: (number | boolean)[];
    try {
      valeurs = await this.lireBloc(table, debut, taille);
    } catch (e) {
      this.marquer('error', lisible(e as Error, `${table}:${debut}`));
      return;
    }

    for (let i = 0; i < valeurs.length; i++) {
      const offset = debut + i;
      const v = valeurs[i];
      if (bit) {
        const texte = v ? 'vrai' : 'faux';
        this.noterCandidat(`${table}:${offset}`, texte, [{ path: '', sample: texte }]);
        continue;
      }
      // Le même registre se lit de plusieurs façons, et rien ne dit laquelle
      // est la bonne. On montre les lectures plausibles côte à côte : c'est
      // celle qui ressemble à une température ou à une pression qui tranche.
      const mot = v as number;
      const paire = valeurs.slice(i, i + 2) as number[];
      const paths = [
        { path: 'uint16', sample: String(mot) },
        { path: 'int16', sample: String(decoder([mot], 'int16')) },
      ];
      if (paire.length === 2) {
        paths.push({ path: 'float32', sample: arrondi(decoder(paire, 'float32')) });
        paths.push({ path: 'float32-swap', sample: arrondi(decoder(paire, 'float32-swap')) });
      }
      this.noterCandidat(formatModbusAddress({ table, offset, type: 'uint16' }), String(mot), paths);
    }
  }
}

/** Ce que « vrai » veut dire pour une bobine, quelle que soit la forme reçue. */
function estVrai(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'on' || s === '1' || s === 'oui';
}

function arrondi(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  return abs > 1e6 || (abs < 1e-4 && v !== 0) ? v.toExponential(2) : String(Number(v.toFixed(3)));
}
