import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ActionLogEntry, ActionOrigin, Command, HouseConfig, Metric } from '@domo/shared';

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

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    // WAL : les lectures de l'interface ne bloquent pas l'écriture des mesures.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
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
      -- elle ne laisse aucune trace ailleurs — d'où la colonne refus.
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
    `);
  }

  // ------------------------------------------------------------ configuration

  loadConfig(): HouseConfig | null {
    const row = this.db.prepare('SELECT payload FROM config WHERE id = 1').get() as
      | { payload: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as HouseConfig;
    } catch {
      return null;
    }
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
    this.db
      .prepare('INSERT INTO reading (at, device_id, metric, value) VALUES (?, ?, ?, ?)')
      .run(Date.now(), deviceId, metric, value);
  }

  history(deviceId: string, sinceMs: number, limit = 2000): Array<{ at: number; value: number }> {
    return this.db
      .prepare(
        `SELECT at, value FROM reading
         WHERE device_id = ? AND at >= ?
         ORDER BY at DESC LIMIT ?`,
      )
      .all(deviceId, sinceMs, limit) as Array<{ at: number; value: number }>;
  }

  // ----------------------------------------------------------------- journal

  logAction(
    deviceId: string,
    command: Command,
    origin: ActionOrigin,
    outcome: ActionLogEntry['outcome'],
  ): void {
    this.db
      .prepare('INSERT INTO action_log (at, device_id, command, origin, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), deviceId, JSON.stringify(command), origin, outcome);
  }

  /**
   * Les mesures d'un équipement sur une fenêtre fermée.
   *
   * `history` ne sait rendre que « depuis » avec un plafond de points, ce qui
   * ne convient pas à un calcul d'énergie : il faut la fenêtre exacte, et tous
   * les points qu'elle contient — un plafond couperait la fin du mois.
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
   * Purge. Mesures brutes conservées 90 jours, journal 2 ans — au-delà on
   * agrégera, mais pas avant que le volume le justifie.
   */
  prune(): void {
    const ninetyDays = Date.now() - 90 * 86_400_000;
    const twoYears = Date.now() - 730 * 86_400_000;
    this.db.prepare('DELETE FROM reading WHERE at < ?').run(ninetyDays);
    this.db.prepare('DELETE FROM action_log WHERE at < ?').run(twoYears);
    this.db.prepare('DELETE FROM scene_run WHERE at < ?').run(twoYears);
  }

  close(): void {
    this.db.close();
  }
}
