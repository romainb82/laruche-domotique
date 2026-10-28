import {
  prochaineOccurrence,
  findCap,
  isActionable,
  type ActionOrigin,
  type Command,
  type HouseConfig,
  type SceneConfig,
} from '@domo/shared';
import type { StateHub } from './state.js';
import type { Db } from './db.js';

/**
 * Le planificateur : ce qui fait partir une scène toute seule.
 *
 * Trois principes, dans cet ordre d'importance.
 *
 * 1. **Rien ne part sans avoir été demandé.** Une scène au repos ne se
 *    déclenche jamais, et une scène dont la condition est fausse ne joue pas.
 *    Le refus est journalisé : « elle n'a rien fait » doit toujours avoir une
 *    raison consultable.
 * 2. **On ne rattrape jamais un départ manqué.** Si le serveur était éteint à
 *    7 h et redémarre à 9 h, le réveil ne part pas. Ouvrir les volets deux
 *    heures trop tard est pire que ne rien faire : la maison agirait sur une
 *    situation qui n'existe plus.
 * 3. **Une scène ne ment pas sur ce qu'elle a fait.** Elle rend le nombre
 *    d'actions transmises et le nombre d'échecs, pas un « c'est bon ».
 *
 * Le retard d'une action est ce qui transforme une scène en séquence : « les
 * volets se ferment, puis les portes se verrouillent trente secondes après ».
 * Ces minuteries sont suivies pour qu'un rechargement de configuration les
 * annule, sinon une scène supprimée continuerait d'agir.
 */

/** À quelle fréquence on regarde l'heure. Un départ part donc dans les 15 s. */
const PERIODE_MS = 15_000;

export interface Execution {
  at: string;
  sceneId: string;
  label: string;
  origin: ActionOrigin;
  total: number;
  echecs: number;
  /** Rempli quand la scène n'est pas partie, et pourquoi. */
  refus: string | null;
}

export interface Resultat {
  ok: boolean;
  scene: string;
  /** Actions que la scène comporte. */
  total: number;
  /** Échecs constatés parmi celles déjà transmises. */
  echecs: number;
  /** Actions encore en attente de leur retard. */
  retardees: number;
  refus?: string;
}

export class Planificateur {
  private horloge: NodeJS.Timeout | null = null;
  private retards = new Set<NodeJS.Timeout>();
  /** sceneId → instant du prochain départ, en millisecondes. */
  private prochaines = new Map<string, number>();
  private config: HouseConfig | null = null;

  constructor(
    private hub: StateHub,
    private db: Db,
    private warn: (m: string) => void = () => {},
  ) {}

  // ------------------------------------------------------------------ cycle

  start(config: HouseConfig): void {
    this.reload(config);
    this.horloge = setInterval(() => this.battre(), PERIODE_MS);
    this.horloge.unref?.();
  }

  stop(): void {
    if (this.horloge) clearInterval(this.horloge);
    this.horloge = null;
    this.annulerRetards();
    this.prochaines.clear();
  }

  /**
   * Recalcule tout à partir de MAINTENANT.
   *
   * Les retards en cours sont annulés : ils appartiennent à une configuration
   * qui n'existe plus, et rien ne dit que leur équipement existe encore.
   */
  reload(config: HouseConfig): void {
    this.config = config;
    this.annulerRetards();
    this.prochaines.clear();

    const maintenant = new Date();
    for (const sc of config.scenes ?? []) {
      if (!sc.enabled) continue;
      const quand = prochaineOccurrence(sc.trigger, maintenant, config.house.timezone);
      if (quand) this.prochaines.set(sc.id, quand.getTime());
    }
  }

  /** Le prochain départ programmé, toutes scènes confondues. */
  prochaine(): { sceneId: string; label: string; at: string } | null {
    let meilleur: { sceneId: string; at: number } | null = null;
    for (const [sceneId, at] of this.prochaines)
      if (!meilleur || at < meilleur.at) meilleur = { sceneId, at };
    if (!meilleur) return null;

    const sc = this.config?.scenes?.find((s) => s.id === meilleur!.sceneId);
    if (!sc) return null;
    return { sceneId: sc.id, label: sc.label, at: new Date(meilleur.at).toISOString() };
  }

  /** Les départs passés, le plus récent d'abord. */
  historique(limit = 40): Execution[] {
    return this.db.recentSceneRuns(limit);
  }

  // ------------------------------------------------------------- exécution

  private battre(): void {
    const maintenant = Date.now();
    for (const [sceneId, at] of [...this.prochaines]) {
      if (at > maintenant) continue;

      const sc = this.config?.scenes?.find((s) => s.id === sceneId);
      // Recalculé AVANT de jouer : sans ça, une scène lente repasserait au
      // battement suivant et partirait deux fois.
      this.replanifier(sceneId);
      if (sc) void this.jouer(sc.id, 'schedule');
    }
  }

  private replanifier(sceneId: string): void {
    const sc = this.config?.scenes?.find((s) => s.id === sceneId);
    if (!sc?.enabled || !this.config) { this.prochaines.delete(sceneId); return; }
    const quand = prochaineOccurrence(sc.trigger, new Date(), this.config.house.timezone);
    if (quand) this.prochaines.set(sceneId, quand.getTime());
    else this.prochaines.delete(sceneId);
  }

  /**
   * Joue une scène.
   *
   * Rend la main dès que les actions immédiates sont transmises : une scène
   * qui verrouille deux minutes plus tard ne doit pas faire attendre deux
   * minutes celui qui a appuyé. Le journal, lui, est écrit quand tout est fini.
   */
  async jouer(sceneId: string, origin: ActionOrigin = 'ui'): Promise<Resultat> {
    const sc = this.config?.scenes?.find((s) => s.id === sceneId);
    if (!sc) throw new Error('Scène inconnue.');
    return this.executer(sc, origin);
  }

  /**
   * Joue une scène telle qu'on la lui donne, enregistrée ou non.
   *
   * C'est ce que fait « Essayer » dans l'éditeur : jouer le BROUILLON, pas la
   * version en base. Sinon l'essai raconte la scène d'hier, et une scène
   * nouvelle n'est même pas jouable avant d'être enregistrée.
   */
  essayer(sc: SceneConfig, origin: ActionOrigin = 'ui'): Promise<Resultat> {
    return this.executer(sc, origin);
  }

  private async executer(sc: SceneConfig, origin: ActionOrigin): Promise<Resultat> {
    const refus = this.refusEventuel(sc, origin);
    if (refus) {
      this.journaliser(sc, origin, 0, 0, refus);
      return { ok: false, scene: sc.label, total: sc.actions.length, echecs: 0, retardees: 0, refus };
    }

    // Les actions sont groupées par retard : un même instant, un même envoi.
    const paquets = new Map<number, SceneConfig['actions']>();
    for (const a of sc.actions) {
      const d = Math.max(0, Math.round(a.afterSeconds ?? 0));
      paquets.set(d, [...(paquets.get(d) ?? []), a]);
    }

    const immediates = paquets.get(0) ?? [];
    paquets.delete(0);
    const echecs = await this.transmettre(immediates, origin);
    const retardees = [...paquets.values()].reduce((n, l) => n + l.length, 0);

    if (!retardees) {
      this.journaliser(sc, origin, sc.actions.length, echecs, null);
      return { ok: echecs === 0, scene: sc.label, total: sc.actions.length, echecs, retardees: 0 };
    }

    // Le reste part plus tard ; le journal attend le dernier paquet.
    let cumul = echecs;
    let restants = paquets.size;
    for (const [delai, actions] of paquets) {
      const minuterie = setTimeout(() => {
        this.retards.delete(minuterie);
        void this.transmettre(actions, origin).then((e) => {
          cumul += e;
          if (--restants === 0) this.journaliser(sc, origin, sc.actions.length, cumul, null);
        });
      }, delai * 1000);
      minuterie.unref?.();
      this.retards.add(minuterie);
    }

    return { ok: echecs === 0, scene: sc.label, total: sc.actions.length, echecs, retardees };
  }

  // ------------------------------------------------------------------ privé

  /**
   * Pourquoi la scène ne part pas, le cas échéant.
   *
   * Un départ à la main passe outre l'interrupteur : couper une scène veut
   * dire « qu'elle ne parte plus toute seule », pas « qu'on ne puisse plus la
   * jouer ». La condition, elle, s'applique dans les deux cas : c'est une
   * garde sur l'état de la maison, pas sur l'intention.
   */
  private refusEventuel(sc: SceneConfig, origin: ActionOrigin): string | null {
    if (origin === 'schedule' && !sc.enabled) return 'Scène au repos.';

    const c = sc.condition;
    if (!c || c.kind !== 'device') return null;

    const etat = this.hub.get(c.deviceId);
    const nom = this.config?.devices.find((d) => d.id === c.deviceId)?.label ?? c.deviceId;
    // Règle 2 : une valeur périmée ne pilote rien. Un module Zigbee mort
    // depuis la veille avec « allumé » figé ne doit pas faire partir une scène.
    if (!isActionable(etat))
      return `Condition invérifiable : « ${nom} » ${etat?.health === 'stale' ? 'ne donne plus de nouvelles' : 'ne répond pas'}.`;

    const allume = findCap(etat, 'switch')?.state === true;
    if (allume === (c.is === 'on')) return null;
    return `Condition non remplie : « ${nom} » est ${allume ? 'allumé' : 'éteint'}.`;
  }

  /** Transmet un paquet d'actions et rend le nombre d'échecs. */
  private async transmettre(
    actions: SceneConfig['actions'],
    origin: ActionOrigin,
  ): Promise<number> {
    const resultats = await Promise.allSettled(
      actions.map((a) => this.hub.command(a.deviceId, a.command as Command, origin)),
    );
    return resultats.filter((r) => r.status === 'rejected').length;
  }

  private journaliser(
    sc: SceneConfig,
    origin: ActionOrigin,
    total: number,
    echecs: number,
    refus: string | null,
  ): void {
    try {
      this.db.logSceneRun(sc.id, sc.label, origin, total, echecs, refus);
    } catch (e) {
      // Un journal qui tombe ne doit pas empêcher la maison d'agir.
      this.warn(`[scène] journal indisponible : ${(e as Error).message}`);
    }
  }

  private annulerRetards(): void {
    for (const t of this.retards) clearTimeout(t);
    this.retards.clear();
  }
}
