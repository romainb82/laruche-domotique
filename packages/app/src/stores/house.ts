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

  // ------------------------------------------------------------- chargement

  async function load() {
    config.value = await api<HouseConfig>('/api/config');
    const snap = await api<{ connections: ConnectionStatus[]; states: DeviceState[] }>('/api/state');
    connections.value = snap.connections;
    states.value = Object.fromEntries(snap.states.map((s) => [s.id, s]));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.onopen = () => {
      connected.value = true;
      error.value = null;
    };

    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === 'connections') {
        connections.value = msg.connections;
      } else if (msg.type === 'snapshot' || msg.type === 'reload') {
        connections.value = msg.connections ?? [];
        states.value = Object.fromEntries(
          (msg.states as DeviceState[]).map((s) => [s.id, s]),
        );
        if (msg.type === 'reload') void load();
      } else if (msg.type === 'state') {
        states.value = { ...states.value, [msg.state.id]: msg.state };
      }
    };

    socket.onclose = () => {
      connected.value = false;
      // Une maison ne doit pas rester muette parce qu'un serveur a redémarré.
      if (retry) clearTimeout(retry);
      retry = window.setTimeout(connect, 2000);
    };
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

  async function send(deviceId: string, command: Command) {
    // Aucune mise à jour optimiste : c'est le serveur qui dira ce qui s'est passé.
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      if (await siSessionExpiree(res)) throw new Error('session expirée');
      const body = await res.json().catch(() => ({ error: 'Commande refusée' }));
      error.value = body.error ?? 'Commande refusée';
      throw new Error(error.value ?? 'erreur');
    }
  }

  async function sendBulk(deviceIds: string[], command: Command) {
    if (!deviceIds.length) return;
    await fetch('/api/commands/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIds, command }),
    });
  }

  async function saveConfig(next: HouseConfig) {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.issues?.map((i: any) => i.message).join('\n') ?? 'Refusé');
    config.value = body.config;
    return body.warnings ?? [];
  }

  async function resetConfig() {
    const res = await fetch('/api/config/reset', { method: 'POST' });
    const body = await res.json();
    config.value = body.config;
  }

  return {
    config, states, connected, connections, error,
    zones, devices, scenes, planZones, offPlanZones,
    load, connect, zone, devicesOf, stateOf,
    send, sendBulk, saveConfig, resetConfig,
  };
});

/**
 * Une session expirée ramène à la page de connexion.
 *
 * Sans ça, une session qui meurt pendant la nuit afficherait « serveur
 * injoignable » au réveil, alors que le serveur va parfaitement bien et qu'il
 * suffit de retaper son mot de passe. Le mensonge serait durable : rien ne
 * viendrait jamais le corriger.
 *
 * L'import est fait ICI et pas en tête de fichier, volontairement : le magasin
 * des comptes importe lui aussi des choses de l'application, et deux modules
 * qui s'importent l'un l'autre au chargement ne s'initialisent pas toujours
 * dans l'ordre qu'on croit.
 */
async function siSessionExpiree(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const [{ useAuth }, { router }] = await Promise.all([
    import('@/stores/auth'),
    import('@/router'),
  ]);
  useAuth().expiree();
  const ou = router.currentRoute.value.fullPath;
  await router.replace({ path: '/connexion', query: ou === '/' ? {} : { redirect: ou } });
  return true;
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    await siSessionExpiree(res);
    throw new Error(`${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}
