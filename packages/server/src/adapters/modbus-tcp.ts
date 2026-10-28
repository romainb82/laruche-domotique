import { Socket } from 'node:net';

/**
 * Un client Modbus TCP, écrit à la main.
 *
 * Pourquoi pas une bibliothèque : les paquets courants tirent avec eux un
 * pilote série natif, qui se compile mal sur un Raspberry Pi et ne sert à rien
 * tant qu'on parle TCP. Le protocole, lui, tient en une page : un en-tête de
 * sept octets suivi d'une poignée de codes fonction. Le faire ici donne en
 * prime des messages d'erreur en français, ce qu'aucune de ces bibliothèques
 * ne rend.
 *
 * Les requêtes sont sérialisées. Le protocole autorise à en empiler plusieurs,
 * mais une bonne partie du matériel industriel ferme la connexion quand on
 * essaie, et une pompe à chaleur qui raccroche vaut moins qu'une milliseconde
 * gagnée.
 */

/** Ce que le protocole autorise en une seule requête. */
export const MAX_MOTS = 125;
export const MAX_BITS = 2000;

type Attente = {
  resolve: (trame: Buffer) => void;
  reject: (e: Error) => void;
  transaction: number;
  minutier: NodeJS.Timeout;
};

export class ModbusTcpClient {
  private socket: Socket | null = null;
  private tampon = Buffer.alloc(0);
  private transaction = 0;
  private enCours: Attente | null = null;
  /** Les requêtes s'enchaînent une par une, jamais en parallèle. */
  private file: Promise<unknown> = Promise.resolve();

  constructor(
    private host: string,
    private port: number,
    private unitId: number,
    private timeoutMs = 5_000,
  ) {}

  get connecte(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new Socket();
      s.setNoDelay(true);

      const echoue = (e: Error) => {
        s.destroy();
        this.socket = null;
        reject(new Error(lisible(e, `${this.host}:${this.port}`)));
      };

      const minutier = setTimeout(
        () => echoue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
        this.timeoutMs,
      );

      s.once('error', (e) => { clearTimeout(minutier); echoue(e); });
      s.connect(this.port, this.host, () => {
        clearTimeout(minutier);
        s.removeAllListeners('error');
        this.socket = s;
        s.on('data', (d) => {
          try {
            this.recevoir(d);
          } catch (e) {
            // Une trame qui ne se lit pas (passerelle boguée, service qui
            // n'est pas du Modbus sur ce port) rompt la requête en cours, et
            // rien d'autre : surtout pas le processus.
            this.tampon = Buffer.alloc(0);
            this.rompre(new Error(`Réponse illisible : ${(e as Error).message}`));
          }
        });
        s.on('error', (e) => this.rompre(new Error(lisible(e, `${this.host}:${this.port}`))));
        s.on('close', () => this.rompre(new Error('Le matériel a fermé la connexion.')));
        resolve();
      });
    });
  }

  close(): void {
    const s = this.socket;
    this.socket = null;
    this.rompre(new Error('Connexion fermée.'));
    s?.removeAllListeners();
    s?.destroy();
  }

  // ------------------------------------------------------------- lectures

  /** Bobines (FC 1) ou entrées tout-ou-rien (FC 2). */
  async readBits(table: 'coil' | 'discrete', offset: number, count: number): Promise<boolean[]> {
    if (count < 1 || count > MAX_BITS)
      throw new Error(`Lecture de ${count} bits : le protocole en autorise 1 à ${MAX_BITS}.`);
    const fc = table === 'coil' ? 1 : 2;
    const corps = Buffer.alloc(4);
    corps.writeUInt16BE(offset, 0);
    corps.writeUInt16BE(count, 2);

    const reponse = await this.envoyer(fc, corps);
    const octets = reponse.readUInt8(0);
    if (octets < Math.ceil(count / 8))
      throw new Error(`Réponse tronquée : ${octets} octets pour ${count} bits attendus.`);

    const bits: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const octet = reponse.readUInt8(1 + (i >> 3));
      bits.push(((octet >> (i % 8)) & 1) === 1);
    }
    return bits;
  }

  /** Registres de maintien (FC 3) ou d'entrée (FC 4). */
  async readWords(table: 'holding' | 'input', offset: number, count: number): Promise<number[]> {
    if (count < 1 || count > MAX_MOTS)
      throw new Error(`Lecture de ${count} registres : le protocole en autorise 1 à ${MAX_MOTS}.`);
    const fc = table === 'holding' ? 3 : 4;
    const corps = Buffer.alloc(4);
    corps.writeUInt16BE(offset, 0);
    corps.writeUInt16BE(count, 2);

    const reponse = await this.envoyer(fc, corps);
    const octets = reponse.readUInt8(0);
    if (octets < count * 2)
      throw new Error(`Réponse tronquée : ${octets} octets pour ${count} registres attendus.`);

    const mots: number[] = [];
    for (let i = 0; i < count; i++) mots.push(reponse.readUInt16BE(1 + i * 2));
    return mots;
  }

  // ------------------------------------------------------------- écritures

  /** Écriture d'une bobine (FC 5). */
  async writeCoil(offset: number, valeur: boolean): Promise<void> {
    const corps = Buffer.alloc(4);
    corps.writeUInt16BE(offset, 0);
    corps.writeUInt16BE(valeur ? 0xff00 : 0x0000, 2);
    await this.envoyer(5, corps);
  }

  /**
   * Écriture de registres (FC 6 pour un seul, FC 16 au-delà).
   *
   * Le cas d'un seul registre passe volontairement par FC 6 : beaucoup
   * d'équipements anciens ne connaissent pas FC 16.
   */
  async writeWords(offset: number, mots: number[]): Promise<void> {
    if (!mots.length) return;
    if (mots.length === 1) {
      const corps = Buffer.alloc(4);
      corps.writeUInt16BE(offset, 0);
      corps.writeUInt16BE(mots[0]! & 0xffff, 2);
      await this.envoyer(6, corps);
      return;
    }
    const corps = Buffer.alloc(5 + mots.length * 2);
    corps.writeUInt16BE(offset, 0);
    corps.writeUInt16BE(mots.length, 2);
    corps.writeUInt8(mots.length * 2, 4);
    mots.forEach((m, i) => corps.writeUInt16BE(m & 0xffff, 5 + i * 2));
    await this.envoyer(16, corps);
  }

  // ------------------------------------------------------------------ privé

  /** Place la requête dans la file et rend le corps de la réponse. */
  private envoyer(fc: number, corps: Buffer): Promise<Buffer> {
    const suite = this.file.then(
      () => this.emettre(fc, corps),
      () => this.emettre(fc, corps),
    );
    // La file ne doit jamais se rompre sur un échec : la requête suivante a le
    // droit de réussir.
    this.file = suite.catch(() => undefined);
    return suite;
  }

  private emettre(fc: number, corps: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed)
        return reject(new Error('Canal Modbus fermé.'));

      this.transaction = (this.transaction + 1) & 0xffff;
      const transaction = this.transaction;

      // En-tête MBAP : transaction, protocole (toujours 0), longueur, esclave.
      const trame = Buffer.alloc(7 + 1 + corps.length);
      trame.writeUInt16BE(transaction, 0);
      trame.writeUInt16BE(0, 2);
      trame.writeUInt16BE(2 + corps.length, 4);
      trame.writeUInt8(this.unitId, 6);
      trame.writeUInt8(fc, 7);
      corps.copy(trame, 8);

      const minutier = setTimeout(() => {
        this.enCours = null;
        reject(new Error(`${this.host}:${this.port} ne répond pas.`));
      }, this.timeoutMs);

      this.enCours = { resolve, reject, transaction, minutier };
      this.socket.write(trame, (e) => {
        if (!e) return;
        clearTimeout(minutier);
        this.enCours = null;
        reject(new Error(lisible(e, `${this.host}:${this.port}`)));
      });
    });
  }

  private recevoir(bloc: Buffer): void {
    this.tampon = Buffer.concat([this.tampon, bloc]);

    // Une réponse peut arriver en plusieurs morceaux, ou plusieurs d'un coup :
    // c'est l'en-tête qui dit où chacune s'arrête.
    while (this.tampon.length >= 8) {
      const longueur = this.tampon.readUInt16BE(4);
      // Une trame annonce au moins l'unité et la fonction (2 octets), et le
      // transport en borne la taille : hors de ça ce n'est pas du Modbus.
      if (longueur < 2 || longueur > 260) throw new Error(`longueur de trame ${longueur}`);
      const total = 6 + longueur;
      if (this.tampon.length < total) return;

      const trame = this.tampon.subarray(0, total);
      this.tampon = this.tampon.subarray(total);

      const attente = this.enCours;
      if (!attente) continue;
      if (trame.readUInt16BE(0) !== attente.transaction) continue; // réponse périmée

      this.enCours = null;
      clearTimeout(attente.minutier);

      const fc = trame.readUInt8(7);
      if (fc & 0x80) {
        // Marqué comme refus DE protocole, par opposition à une panne de
        // transport : un équipement qui refuse une requête est un équipement
        // qui parle Modbus, et c'est ce que l'essai à blanc cherche à savoir.
        attente.reject(
          Object.assign(new Error(exception(trame.readUInt8(8))), { modbus: true as const }),
        );
        continue;
      }
      attente.resolve(trame.subarray(8));
    }
  }

  private rompre(e: Error): void {
    const attente = this.enCours;
    this.enCours = null;
    if (attente) {
      clearTimeout(attente.minutier);
      attente.reject(e);
    }
  }
}

// --------------------------------------------------------------- décodage

/**
 * Traduit une suite de mots en valeur.
 *
 * Le `-swap` inverse l'ordre des deux mots. La moitié du matériel place le mot
 * de poids fort en premier, l'autre en second, et la documentation l'omet une
 * fois sur deux, d'où le réglage plutôt qu'une devinette.
 */
export function decoder(mots: number[], type: string): number | undefined {
  if (type === 'uint16') return mots[0];
  if (type === 'int16') {
    const v = mots[0];
    return v === undefined ? undefined : (v & 0x8000 ? v - 0x10000 : v);
  }
  if (mots.length < 2 || mots[0] === undefined || mots[1] === undefined) return undefined;

  const inverse = type.endsWith('-swap');
  const haut = inverse ? mots[1] : mots[0];
  const bas = inverse ? mots[0] : mots[1];

  const b = Buffer.alloc(4);
  b.writeUInt16BE(haut, 0);
  b.writeUInt16BE(bas, 2);

  if (type.startsWith('float32')) return b.readFloatBE(0);
  if (type.startsWith('int32')) return b.readInt32BE(0);
  return b.readUInt32BE(0);
}

/** L'inverse : une valeur vers les mots à écrire. */
export function encoder(valeur: number, type: string): number[] {
  if (type === 'uint16') return [Math.round(valeur) & 0xffff];
  if (type === 'int16') {
    const v = Math.round(valeur);
    return [(v < 0 ? v + 0x10000 : v) & 0xffff];
  }
  const b = Buffer.alloc(4);
  if (type.startsWith('float32')) b.writeFloatBE(valeur, 0);
  else if (type.startsWith('int32')) b.writeInt32BE(Math.round(valeur), 0);
  else b.writeUInt32BE(Math.round(valeur) >>> 0, 0);

  const haut = b.readUInt16BE(0);
  const bas = b.readUInt16BE(2);
  return type.endsWith('-swap') ? [bas, haut] : [haut, bas];
}

// ------------------------------------------------------------------ erreurs

/**
 * Les codes d'exception du protocole, en clair.
 *
 * Le code 2 est de loin le plus fréquent, et le plus trompeur : il ne veut pas
 * dire que l'équipement est en panne, mais qu'on lui parle d'un registre qu'il
 * n'a pas. Presque toujours un décalage de 1, ou la notation Modicon prise au
 * pied de la lettre.
 */
function exception(code: number): string {
  switch (code) {
    case 1: return "L'équipement ne connaît pas cette fonction Modbus.";
    case 2: return "Ce registre n'existe pas chez cet équipement : vérifie l'adresse, elle commence à 0.";
    case 3: return 'Valeur refusée par l’équipement : hors des bornes qu’il accepte.';
    case 4: return "L'équipement signale une panne interne.";
    case 5: return 'Requête acceptée, réponse longue à venir : réessaie.';
    case 6: return "L'équipement est occupé.";
    case 10: case 11: return "La passerelle ne trouve pas l'esclave : vérifie l'identifiant.";
    default: return `L'équipement a refusé la requête (code ${code}).`;
  }
}

/** Vrai si l'équipement a répondu, même pour refuser. */
export function estRefusModbus(e: unknown): boolean {
  return !!(e as { modbus?: boolean } | null)?.modbus;
}

/** Les pannes de transport, dites comme on les dirait à quelqu'un. */
export function lisible(e: Error, cible: string): string {
  const code = (e as Error & { code?: string }).code ?? '';
  const m = e.message || String(e);
  if (code === 'ECONNREFUSED') return `Connexion refusée sur ${cible}.`;
  if (code === 'ETIMEDOUT' || m.includes('timeout')) return `${cible} ne répond pas.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Adresse introuvable : ${cible}.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Réseau injoignable depuis le serveur.';
  if (code === 'ECONNRESET') return `${cible} a coupé la connexion.`;
  return m || `${cible} injoignable.`;
}
