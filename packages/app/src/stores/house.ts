import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  Command,
  ConnectionStatus,
  DeviceConfig,
  DeviceState,
  HouseConfig,
  ZoneConfig,
} from '@domo/shared';
import { http } from '@/stores/http';

/**
 * Source de vérité côté interface.
 *
 * L'état des équipements n'est JAMAIS modifié localement en réponse à un clic :
 * on envoie la commande, et on attend que le serveur pousse l'état réel. C'est
 * ce qui garantit que l'affichage ne ment pas sur ce que fait la maison.
 */
export const useHouse = defineStore('house', () => {
  const config = ref<HouseConfig | null>(null);
  const states = ref<Record<string, DeviceState>>({});
  const connected = ref(false);
  const connections = ref<ConnectionStatus[]>([]);
  const error = ref<string | null>(null);

  let socket: WebSocket | null = null;
  let retry: number | null = null;
  let veille: number | null = null;
  /** Vrai entre `connect()` et `disconnect()` : sinon, un lien fermé reste fermé. */
  let voulu = false;
  /** Nombre d'échecs consécutifs : fixe l'attente avant le prochain essai. */
  let echecs = 0;

  // ------------------------------------------------------------- chargement

  async function load() {
    config.value = await http<HouseConfig>('/api/config');
    const snap = await http<{ connections: ConnectionStatus[]; states: DeviceState[] }>('/api/state');
    connections.value = snap.connections;
    states.value = Object.fromEntries(snap.states.map((s) => [s.id, s]));
  }

  /**
   * Le lien vivant avec la maison.
   *
   * Un seul socket à la fois : rappeler `connect()` pendant qu'un lien est
   * ouvert ou en cours d'ouverture ne fait rien. La reprise attend de plus en
   * plus longtemps après chaque échec (1 s, 2 s… jusqu'à 30 s, avec un peu de
   * hasard pour que dix téléphones ne reviennent pas à la même seconde), et
   * revient à 1 s dès qu'un lien tient.
   *
   * Le serveur parle toutes les 5 s (santé des canaux) : quinze secondes de
   * silence veulent dire que le lien est mort sans FIN : un Pi débranché, un
   * Wi-Fi qui a décroché : et on le referme nous-mêmes pour en rouvrir un.
   * Sans cette veille, `connected` resterait vrai pendant des minutes.
   */
  function connect() {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new WebSocket(`${proto}://${location.host}/ws`);
    socket = s;

    s.onopen = () => {
      connected.value = true;
      error.value = null;
      echecs = 0;
      surveiller();
      // Le socket donne les états ; la configuration, elle, peut avoir bougé
      // pendant la coupure.
      void load().catch(() => undefined);
    };

    s.onmessage = (ev) => {
      surveiller();
      let msg: any;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === 'connections') {
        connections.value = msg.connections;
      } else if (msg.type === 'snapshot' || msg.type === 'reload') {
        connections.value = msg.connections ?? [];
        states.value = Object.fromEntries(
          (msg.states as DeviceState[]).map((s) => [s.id, s]),
        );
        if (msg.type === 'reload') void load().catch(() => undefined);
      } else if (msg.type === 'state') {
        states.value = { ...states.value, [msg.state.id]: msg.state };
      }
    };

    s.onclose = () => {
      if (socket !== s) return; // un lien plus récent a pris la place
      socket = null;
      connected.value = false;
      if (veille) clearTimeout(veille);
      if (!voulu) return;
      // Une maison ne doit pas rester muette parce qu'un serveur a redémarré.
      echecs += 1;
      const attente = Math.min(30_000, 1_000 * 2 ** Math.min(echecs - 1, 5)) * (0.8 + Math.random() * 0.4);
      retry = window.setTimeout(connect, attente);
    };
  }

  function surveiller() {
    if (veille) clearTimeout(veille);
    veille = window.setTimeout(() => {
      // Silence trop long : on force la reprise. `close()` déclenche `onclose`.
      socket?.close();
    }, 15_000);
  }

  /** Ferme le lien et n'essaie plus : à la déconnexion, ou quand la session a expiré. */
  function disconnect() {
    voulu = false;
    if (retry) clearTimeout(retry);
    if (veille) clearTimeout(veille);
    retry = veille = null;
    const s = socket;
    socket = null;
    s?.close();
    connected.value = false;
    states.value = {};
    connections.value = [];
    config.value = null;
  }

  function ouvrir() {
    voulu = true;
    connect();
  }

  // ---------------------------------------------------------------- lecture

  const zones = computed<ZoneConfig[]>(() =>
    [...(config.value?.zones ?? [])].sort((a, b) => a.order - b.order),
  );

  const devices = computed<DeviceConfig[]>(() => config.value?.devices ?? []);

  /** Les scènes, dans l'ordre voulu par l'utilisateur. */
  const scenes = computed(() =>
    [...(config.value?.scenes ?? [])].sort((a, b) => a.order - b.order),
  );

  function zone(id: string) {
    return zones.value.find((z) => z.id === id);
  }

  function devicesOf(zoneId: string): DeviceConfig[] {
    return devices.value
      .filter((d) => d.zoneId === zoneId)
      .sort((a, b) => a.order - b.order);
  }

  function stateOf(id: string): DeviceState | undefined {
    return states.value[id];
  }

  /** Zones affichables sur le plan, dans l'ordre. */
  const planZones = computed(() => zones.value.filter((z) => z.plan?.length));
  const offPlanZones = computed(() => zones.value.filter((z) => !z.plan?.length));

  // ---------------------------------------------------------------- actions

  /**
   * Règle 2, tenue ici pour TOUTES les vues : une valeur périmée ne pilote
   * rien, et on n'empile pas une commande sur une autre encore en cours.
   * Les tuiles, le plan, le cadran et les raccourcis clavier passent tous par
   * ces deux fonctions : c'est le seul endroit où la règle ne peut pas être
   * oubliée.
   */
  function pilotable(id: string): string | null {
    const s = states.value[id];
    if (!s || s.health !== 'online') return 'Cet équipement ne donne plus de nouvelles : on ne le pilote pas à l’aveugle.';
    if (s.pending) return 'Commande déjà en cours, on attend la réponse du matériel.';
    return null;
  }

  async function send(deviceId: string, command: Command) {
    const refus = pilotable(deviceId);
    if (refus) {
      error.value = refus;
      throw new Error(refus);
    }
    // Aucune mise à jour optimiste : c'est le serveur qui dira ce qui s'est passé.
    try {
      await http(`/api/devices/${encodeURIComponent(deviceId)}/command`, { method: 'POST', body: command });
      error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function sendBulk(deviceIds: string[], command: Command) {
    // Les périmés et les « en cours » sont laissés de côté, et on le dit.
    const retenus = deviceIds.filter((id) => !pilotable(id));
    const ecartes = deviceIds.length - retenus.length;
    if (!retenus.length) {
      if (ecartes) error.value = 'Aucun de ces équipements ne peut être piloté pour le moment.';
      return;
    }
    try {
      const r = await http<{ ok: boolean; total: number; failed: number }>('/api/commands/bulk', {
        method: 'POST',
        body: { deviceIds: retenus, command },
      });
      const rates = r.failed + ecartes;
      error.value = rates
        ? `${rates} équipement${rates > 1 ? 's' : ''} sur ${deviceIds.length} n’${rates > 1 ? 'ont' : 'a'} pas été piloté${rates > 1 ? 's' : ''}.`
        : null;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function saveConfig(next: HouseConfig) {
    const body = await http<{ config: HouseConfig; warnings?: unknown[] }>('/api/config', {
      method: 'PUT',
      body: next,
      delaiMs: 30_000,
    });
    config.value = body.config;
    return body.warnings ?? [];
  }

  async function resetConfig() {
    const body = await http<{ config: HouseConfig }>('/api/config/reset', { method: 'POST', delaiMs: 30_000 });
    config.value = body.config;
  }

  return {
    config, states, connected, connections, error,
    zones, devices, scenes, planZones, offPlanZones,
    load, connect: ouvrir, disconnect, zone, devicesOf, stateOf,
    send, sendBulk, pilotable, saveConfig, resetConfig,
  };
});

