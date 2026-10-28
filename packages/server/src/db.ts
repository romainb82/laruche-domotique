import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  ActionLogEntry,
  ActionOrigin,
  Command,
  Compte,
  HouseConfig,
  Metric,
  Role,
} from '@domo/shared';

/** Une ligne de la table `compte`, telle que SQLite la rend. */
interface LigneCompte {
  id: string;
  identifiant: string;
  nom: string;
  role: string;
  hash: string;
  cree_le: number;
  derniere_connexion: number | null;
  actif: number;
}

/**
 * De la ligne SQLite au compte du domaine.
 *
 * Deux conversions que SQLite impose : il n'a pas de booléen (d'où `actif`
 * stocké en 0/1) et les dates sont rangées en millisecondes pour être
 * comparables sans fonction, alors que tout le reste du projet échange de
 * l'ISO 8601.
 */
function versCompte(r: LigneCompte): Compte {
  return {
    id: r.id,
    identifiant: r.identifiant,
    nom: r.nom,
    role: r.role as Role,
    creeLe: new Date(r.cree_le).toISOString(),
    derniereConnexion: r.derniere_connexion ? new Date(r.derniere_connexion).toISOString() : null,
    actif: r.actif === 1,
  };
}

/**
 * Stockage local.
 *
 * SQLite plutôt que PostgreSQL : le serveur tourne sur un Raspberry Pi, pour
 * une maison. Un fichier unique, aucun service à superviser, sauvegarde par
 * simple copie, et largement de quoi tenir les ~2 M de points par an que
 * produit la maison. PostgreSQL serait un conteneur et 200 Mo de RAM pour
 * rendre exactement le même service.
 *
 * Rien de tout ça ne passe par le réseau : si la fibre tombe, la maison
 * continue de fonctionner.
 */
export class Db {
  private db: Database.Database;
  /**
   * Les requêtes du chemin chaud, préparées une fois.
   *
   * `prepare()` à chaque appel coûte une analyse SQL ; à une mesure par seconde
   * et par équipement, et une vérification de session par requête HTTP, c'est
   * du travail inutile sur un Pi. Les autres requêtes, rares, restent
   * préparées à la volée : lisibilité d'abord.
   */
  private readonly req: {
    sessionValide: Database.Statement;
    toucherSession: Database.Statement;
    recordReading: Database.Statement;
    logAction: Database.Statement;
  };

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    // WAL : les lectures de l'interface ne bloquent pas l'écriture des mesures.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.req = {
      sessionValide: this.db.prepare(
        `SELECT s.id AS sid, s.vue_le AS vue_le, c.* FROM session s
         JOIN compte c ON c.id = s.compte_id
         WHERE s.empreinte = ? AND s.expire_le > ? AND c.actif = 1`,
      ),
      toucherSession: this.db.prepare('UPDATE session SET vue_le = ?, expire_le = ? WHERE id = ?'),
      recordReading: this.db.prepare(
        'INSERT INTO reading (at, device_id, metric, value) VALUES (?, ?, ?, ?)',
      ),
      logAction: this.db.prepare(
        'INSERT INTO action_log (at, device_id, command, origin, outcome) VALUES (?, ?, ?, ?, ?)',
      ),
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT    NOT NULL,
        saved_at TEXT   NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reading (
        at        INTEGER NOT NULL,
        device_id TEXT    NOT NULL,
        metric    TEXT    NOT NULL,
        value     REAL    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reading_device_at ON reading (device_id, at);

      -- Le jour où un volet se ferme seul à 14 h, la seule question qui compte
      -- est « quelle règle a fait ça ». D'où la colonne origin.
      CREATE TABLE IF NOT EXISTS action_log (
        at        INTEGER NOT NULL,
        device_id TEXT    NOT NULL,
        command   TEXT    NOT NULL,
        origin    TEXT    NOT NULL,
        outcome   TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_log_at ON action_log (at DESC);

      -- Le journal des scènes. Il répond à une question que le journal des
      -- actions ne sait pas traiter : « pourquoi le réveil n'est-il pas
      -- parti ce matin ». Une scène refusée n'émet aucune commande, donc
      -- elle ne laisse aucune trace ailleurs, d'où la colonne refus.
      CREATE TABLE IF NOT EXISTS scene_run (
        at       INTEGER NOT NULL,
        scene_id TEXT    NOT NULL,
        label    TEXT    NOT NULL,
        origin   TEXT    NOT NULL,
        total    INTEGER NOT NULL,
        echecs   INTEGER NOT NULL,
        refus    TEXT
      );
      CREATE INDEX IF NOT EXISTS scene_run_at ON scene_run (at DESC);

      -- Les comptes. L'identifiant est unique SANS tenir compte de la casse :
      -- « Romain » et « romain » doivent être la même personne, sinon deux
      -- comptes homonymes cohabitent et personne ne comprend pourquoi le mot
      -- de passe « ne marche plus ».
      CREATE TABLE IF NOT EXISTS compte (
        id                 TEXT    PRIMARY KEY,
        identifiant        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        nom                TEXT    NOT NULL,
        role               TEXT    NOT NULL,
        hash               TEXT    NOT NULL,
        cree_le            INTEGER NOT NULL,
        derniere_connexion INTEGER,
        actif              INTEGER NOT NULL DEFAULT 1
      );

      -- Les sessions ouvertes. On stocke l'EMPREINTE du jeton, jamais le jeton :
      -- une copie de ce fichier ne doit donner accès à rien.
      --
      -- ON DELETE CASCADE : supprimer un compte ferme ses sessions dans le même
      -- mouvement. Sans ça, un compte révoqué garderait son accès jusqu'à
      -- expiration : exactement ce qu'on cherche à empêcher en le supprimant.
      CREATE TABLE IF NOT EXISTS session (
        id        TEXT    PRIMARY KEY,
        compte_id TEXT    NOT NULL REFERENCES compte(id) ON DELETE CASCADE,
        empreinte TEXT    NOT NULL UNIQUE,
        appareil  TEXT    NOT NULL,
        cree_le   INTEGER NOT NULL,
        vue_le    INTEGER NOT NULL,
        expire_le INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_compte ON session (compte_id);
    `);

    // Les clés étrangères sont désactivées par défaut dans SQLite. Sans cette
    // ligne, le ON DELETE CASCADE ci-dessus ne serait qu'un commentaire.
    this.db.pragma('foreign_keys = ON');
  }

  // ----------------------------------------------------------------- comptes

  /** Zéro signifie « maison neuve » : l'interface proposera de créer le premier compte. */
  nbComptes(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM compte').get() as { n: number }).n;
  }

  comptes(): Compte[] {
    const rows = this.db.prepare('SELECT * FROM compte ORDER BY cree_le ASC').all() as LigneCompte[];
    return rows.map(versCompte);
  }

  compte(id: string): Compte | null {
    const row = this.db.prepare('SELECT * FROM compte WHERE id = ?').get(id) as
      | LigneCompte
      | undefined;
    return row ? versCompte(row) : null;
  }

  /** Le compte ET son hachage : réservé à la vérification du mot de passe. */
  identification(identifiant: string): { compte: Compte; hash: string } | null {
    const row = this.db
      .prepare('SELECT * FROM compte WHERE identifiant = ? COLLATE NOCASE')
      .get(identifiant) as LigneCompte | undefined;
    return row ? { compte: versCompte(row), hash: row.hash } : null;
  }

  creerCompte(c: {
    id: string;
    identifiant: string;
    nom: string;
    role: Role;
    hash: string;
  }): Compte {
    this.db
      .prepare(
        `INSERT INTO compte (id, identifiant, nom, role, hash, cree_le, derniere_connexion, actif)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`,
      )
      .run(c.id, c.identifiant, c.nom, c.role, c.hash, Date.now());
    return this.compte(c.id)!;
  }

  modifierCompte(id: string, champs: { nom?: string; role?: Role; actif?: boolean }): Compte | null {
    const actuel = this.compte(id);
    if (!actuel) return null;
    this.db
      .prepare('UPDATE compte SET nom = ?, role = ?, actif = ? WHERE id = ?')
      .run(
        champs.nom ?? actuel.nom,
        champs.role ?? actuel.role,
        (champs.actif ?? actuel.actif) ? 1 : 0,
        id,
      );
    return this.compte(id);
  }

  changerMotDePasse(id: string, hash: string): void {
    this.db.prepare('UPDATE compte SET hash = ? WHERE id = ?').run(hash, id);
  }

  marquerConnexion(id: string): void {
    this.db.prepare('UPDATE compte SET derniere_connexion = ? WHERE id = ?').run(Date.now(), id);
  }

  supprimerCompte(id: string): void {
    this.db.prepare('DELETE FROM compte WHERE id = ?').run(id);
  }

  /** Combien d'administrateurs actifs restent. Sert à ne jamais tomber à zéro. */
  nbAdmins(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM compte WHERE role = 'admin' AND actif = 1")
      .get() as { n: number };
    return r.n;
  }

  // ---------------------------------------------------------------- sessions

  ouvrirSession(s: {
    id: string;
    compteId: string;
    empreinte: string;
    appareil: string;
    dureeJours: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session (id, compte_id, empreinte, appareil, cree_le, vue_le, expire_le)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.compteId, s.empreinte, s.appareil, now, now, now + s.dureeJours * 86_400_000);
  }

  /**
   * Le compte derrière un jeton, si la session est encore valable.
   *
   * Un compte désactivé est refusé ici, et pas seulement à la connexion :
   * sinon, désactiver quelqu'un ne ferait effet qu'à sa prochaine ouverture de
   * session, c'est-à-dire potentiellement jamais.
   */
  sessionValide(
    empreinte: string,
  ): { compte: Compte; sessionId: string; vueLe: number } | null {
    const row = this.req.sessionValide.get(empreinte, Date.now()) as
      | (LigneCompte & { sid: string; vue_le: number })
      | undefined;
    return row ? { compte: versCompte(row), sessionId: row.sid, vueLe: row.vue_le } : null;
  }

  /**
   * Repousse l'expiration.
   *
   * Sans ça, la session meurt trente jours après son ouverture même si on s'en
   * sert tous les jours, et on se retrouve déconnecté sans raison apparente.
   *
   * Pas plus d'une écriture par heure et par session : une session vit des
   * jours, la prolonger à chaque requête : jusqu'à une par seconde avec les
   * caméras : userait la carte du Pi pour rien. Une panne d'écriture ne doit
   * pas refuser la requête : la session reste valable, elle expirera juste un
   * peu plus tôt.
   */
  toucherSession(id: string, vueLe: number, dureeJours: number): void {
    const now = Date.now();
    if (now - vueLe < 3_600_000) return;
    try {
      this.req.toucherSession.run(now, now + dureeJours * 86_400_000, id);
    } catch (e) {
      console.warn(`[base] session non prolongée : ${(e as Error).message}`);
    }
  }

  sessionsDe(compteId: string): Array<{ id: string; appareil: string; creeLe: string; vueLe: string }> {
    const rows = this.db
      .prepare(
        'SELECT id, appareil, cree_le, vue_le FROM session WHERE compte_id = ? AND expire_le > ? ORDER BY vue_le DESC',
      )
      .all(compteId, Date.now()) as Array<{
      id: string;
      appareil: string;
      cree_le: number;
      vue_le: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      appareil: r.appareil,
      creeLe: new Date(r.cree_le).toISOString(),
      vueLe: new Date(r.vue_le).toISOString(),
    }));
  }

  /**
   * `compteId` est facultatif mais fourni par les routes : il empêche de
   * fermer la session de quelqu'un d'autre en devinant un identifiant.
   */
  fermerSession(id: string, compteId?: string): void {
    if (compteId)
      this.db.prepare('DELETE FROM session WHERE id = ? AND compte_id = ?').run(id, compteId);
    else this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
  }

  fermerSessionsDe(compteId: string): void {
    this.db.prepare('DELETE FROM session WHERE compte_id = ?').run(compteId);
  }

  /** Les sessions expirées ne servent plus à rien : on les balaie au démarrage. */
  purgerSessions(): number {
    return this.db.prepare('DELETE FROM session WHERE expire_le <= ?').run(Date.now()).changes;
  }

  // ------------------------------------------------------------ configuration

  /**
   * La configuration, ou `null` s'il n'y en a pas encore.
   *
   * Une ligne illisible (coupure pendant l'écriture, carte abîmée) LÈVE au
   * lieu de rendre `null` : « rien » et « cassé » ne doivent pas se ressembler,
   * sinon le serveur remplacerait en silence une maison configurée par la
   * maison de référence. La ligne est d'abord mise de côté pour qu'on puisse la
   * récupérer à la main.
   */
  loadConfig(): HouseConfig | null {
    const row = this.db.prepare('SELECT payload FROM config WHERE id = 1').get() as
      | { payload: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as HouseConfig;
    } catch (e) {
      this.mettreDeCote(row.payload);
      throw new Error(
        `La configuration en base est illisible (${(e as Error).message}). ` +
          'Elle a été copiée dans la table config_abimee ; le serveur refuse de la remplacer tout seul.',
      );
    }
  }

  /** Range une configuration qu'on ne peut pas appliquer, pour la récupérer à la main. */
  mettreDeCote(payload: string): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS config_abimee (at TEXT NOT NULL, payload TEXT NOT NULL)',
    );
    this.db
      .prepare('INSERT INTO config_abimee (at, payload) VALUES (?, ?)')
      .run(new Date().toISOString(), payload);
  }

  saveConfig(config: HouseConfig): void {
    this.db
      .prepare(
        `INSERT INTO config (id, payload, saved_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at`,
      )
      .run(JSON.stringify(config), new Date().toISOString());
  }

  // ----------------------------------------------------------------- mesures

  recordReading(deviceId: string, metric: Metric, value: number): void {
    this.req.recordReading.run(Date.now(), deviceId, metric, value);
  }

  /**
   * L'historique d'un équipement, échantillonné.
   *
   * Un graphique de 24 h n'a pas besoin de 86 400 points, et un plafond de
   * lignes « les plus récentes » mentirait sur la fenêtre affichée (à une
   * mesure par seconde, 2 000 lignes font 33 minutes, pas 24 heures). On
   * découpe donc la fenêtre en `points` seaux et on rend la moyenne de chacun :
   * toute la fenêtre, à une résolution que l'écran peut montrer.
   */
  history(deviceId: string, sinceMs: number, points = 600): Array<{ at: number; value: number }> {
    const seau = Math.max(1000, Math.ceil((Date.now() - sinceMs) / points));
    return this.db
      .prepare(
        `SELECT (at / ?) * ? AS at, AVG(value) AS value FROM reading
         WHERE device_id = ? AND at >= ?
         GROUP BY at / ? ORDER BY at`,
      )
      .all(seau, seau, deviceId, sinceMs, seau) as Array<{ at: number; value: number }>;
  }

  // ----------------------------------------------------------------- journal

  logAction(
    deviceId: string,
    command: Command,
    origin: ActionOrigin,
    outcome: ActionLogEntry['outcome'],
  ): void {
    this.req.logAction.run(Date.now(), deviceId, JSON.stringify(command), origin, outcome);
  }

  /**
   * Les mesures d'un équipement sur une fenêtre fermée.
   *
   * `history` ne sait rendre que « depuis » avec un plafond de points, ce qui
   * ne convient pas à un calcul d'énergie : il faut la fenêtre exacte, et tous
   * les points qu'elle contient : un plafond couperait la fin du mois.
   */
  readings(deviceId: string, de: number, a: number): Array<{ at: number; value: number }> {
    return this.db
      .prepare('SELECT at, value FROM reading WHERE device_id = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(deviceId, de, a) as Array<{ at: number; value: number }>;
  }

  logSceneRun(
    sceneId: string,
    label: string,
    origin: ActionOrigin,
    total: number,
    echecs: number,
    refus: string | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO scene_run (at, scene_id, label, origin, total, echecs, refus) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(Date.now(), sceneId, label, origin, total, echecs, refus);
  }

  recentSceneRuns(limit = 40): Array<{
    at: string;
    sceneId: string;
    label: string;
    origin: ActionOrigin;
    total: number;
    echecs: number;
    refus: string | null;
  }> {
    const rows = this.db
      .prepare(
        'SELECT at, scene_id, label, origin, total, echecs, refus FROM scene_run ORDER BY at DESC LIMIT ?',
      )
      .all(limit) as Array<{
      at: number; scene_id: string; label: string;
      origin: string; total: number; echecs: number; refus: string | null;
    }>;
    return rows.map((r) => ({
      at: new Date(r.at).toISOString(),
      sceneId: r.scene_id,
      label: r.label,
      origin: r.origin as ActionOrigin,
      total: r.total,
      echecs: r.echecs,
      refus: r.refus,
    }));
  }

  recentActions(limit = 100): ActionLogEntry[] {
    const rows = this.db
      .prepare('SELECT at, device_id, command, origin, outcome FROM action_log ORDER BY at DESC LIMIT ?')
      .all(limit) as Array<{
      at: number;
      device_id: string;
      command: string;
      origin: string;
      outcome: string;
    }>;
    return rows.map((r) => ({
      at: new Date(r.at).toISOString(),
      deviceId: r.device_id,
      command: JSON.parse(r.command) as Command,
      origin: r.origin as ActionOrigin,
      outcome: r.outcome as ActionLogEntry['outcome'],
    }));
  }

  /**
   * Purge. Mesures brutes conservées 90 jours, journal 2 ans : au-delà on
   * agrégera, mais pas avant que le volume le justifie.
   */
  /**
   * Purge, par lots.
   *
   * Un `DELETE` de plusieurs millions de lignes bloque le processus le temps
   * qu'il dure : des secondes sur un Pi, pendant lesquelles aucune commande ne
   * part et les délais de garde expirent en rafale. On efface donc par
   * tranches de 5 000 lignes en rendant la main entre deux, et on s'arrête
   * dès qu'une tranche revient incomplète.
   */
  async prune(): Promise<void> {
    const ninetyDays = Date.now() - 90 * 86_400_000;
    const twoYears = Date.now() - 730 * 86_400_000;
    const LOT = 5_000;
    const cibles: Array<[string, number]> = [
      ['reading', ninetyDays],
      ['action_log', twoYears],
      ['scene_run', twoYears],
    ];
    for (const [table, avant] of cibles) {
      const stmt = this.db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE at < ? LIMIT ?)`,
      );
      for (;;) {
        const { changes } = stmt.run(avant, LOT);
        if (changes < LOT) break;
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
