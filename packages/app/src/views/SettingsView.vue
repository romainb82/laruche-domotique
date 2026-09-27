<script setup lang="ts">
/**
 * Paramétrage complet.
 *
 * L'objectif tenu ici : le jour où le matériel arrive, il n'y a AUCUN code à
 * écrire. On ajoute la zone, on ajoute l'équipement, on colle les deux topics
 * MQTT du module, on bascule le driver. C'est tout.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  DEVICE_TYPE_LABELS, METRIC_LABELS, ZONE_KIND_LABELS,
  type Candidate, type Connection, type ConnectionStatus, type DeviceConfig,
  type DeviceType, type HouseConfig, type Metric, type Preset,
  type ZoneConfig, type ZoneKind,
} from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useAnnonce } from '@/composables/useAnnonce';
import ConnectionCard from '@/components/ConnectionCard.vue';
import WiringEditor from '@/components/WiringEditor.vue';

const house = useHouse();
// Le résultat d'un essai doit être DIT, pas seulement affiché.
const { annoncer } = useAnnonce();

/**
 * Copie de travail.
 *
 * L'API native de clonage ne sait pas dupliquer un proxy réactif Vue : elle
 * lève « could not be cloned » et l'écran reste blanc. La configuration est du
 * JSON pur (ni Date, ni Map), donc l'aller-retour JSON est exact — et, ici, le
 * seul qui fonctionne.
 */
function copie<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Tab = 'maison' | 'zones' | 'equipements' | 'materiel' | 'cameras';
const ONGLETS: { id: Tab; libelle: string }[] = [
  { id: 'maison', libelle: 'Maison' },
  { id: 'zones', libelle: 'Zones' },
  { id: 'equipements', libelle: 'Équipements' },
  { id: 'materiel', libelle: 'Matériel' },
  { id: 'cameras', libelle: 'Caméras' },
];
const tab = ref<Tab>('maison');

/**
 * L'état réel du pont HomeKit.
 *
 * Il ne se déduit pas du brouillon : cocher « ouvrir » n'ouvre rien tant qu'on
 * n'a pas enregistré, et un pont peut refuser de s'ouvrir. On demande donc au
 * serveur ce qu'il en est vraiment — c'est la même règle que partout ailleurs.
 */
// ---------------------------------------------------------------- caméras

/**
 * Une caméra neuve naît AU REPOS, sans adresse.
 *
 * Elle ne filmera donc rien tant qu'on ne l'a pas remplie puis allumée
 * sciemment. Le contraire — une caméra active dès sa création — serait la
 * pire valeur par défaut de toute l'application.
 */
function ajouterCamera() {
  if (!draft.value) return;
  const n = (draft.value.cameras ?? []).length;
  draft.value.cameras = [
    ...(draft.value.cameras ?? []),
    {
      id: `cam-${Date.now().toString(36).slice(-5)}`,
      label: 'Nouvelle caméra',
      zoneId: '',
      order: n,
      enabled: false,
      snapshotUrl: '',
      username: '',
      password: '',
      refreshSeconds: 2,
    },
  ];
}

function retirerCamera(id: string) {
  if (!draft.value) return;
  draft.value.cameras = (draft.value.cameras ?? []).filter((c) => c.id !== id);
}

/** L'essai à blanc, avant d'allumer. Le serveur essaie, pas le navigateur. */
const essais = ref<Record<string, { etat: 'attente' | 'ok' | 'ko'; texte: string }>>({});

async function testerCamera(id: string) {
  const cam = (draft.value?.cameras ?? []).find((c) => c.id === id);
  if (!cam) return;
  essais.value[id] = { etat: 'attente', texte: 'Connexion en cours…' };
  try {
    const res = await fetch('/api/cameras/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cam),
    });
    const corps = await res.json();
    essais.value[id] = corps.ok
      ? { etat: 'ok', texte: `Image reçue en ${corps.ms} ms — ${Math.round(corps.octets / 1024)} ko, ${corps.type}.` }
      : { etat: 'ko', texte: corps.error ?? 'Échec.' };
  } catch (e) {
    essais.value[id] = { etat: 'ko', texte: (e as Error).message };
  }
  annoncer(`${cam.label} : ${essais.value[id]!.texte}`);
}

/** Les capteurs qui mesurent une puissance : les seuls candidats au rôle de compteur. */
const compteurs = computed(() =>
  (draft.value?.devices ?? []).filter((d) => d.type === 'sensor' && d.metric === 'power'),
);

const pont = ref<{
  enabled: boolean; published: boolean; error: string | null;
  exposes: number; skipped: { label: string; raison: string }[]; pin: string | null;
} | null>(null);

/**
 * Ce que le planificateur a fait, et ce qu'il va faire.
 *
 * Demandé au serveur plutôt que déduit du brouillon : une scène programmée
 * dans la page mais pas encore enregistrée ne part pas, et laisser croire le
 * contraire serait le pire des mensonges pour une maison qui bouge toute
 * seule.
 */
const prochainDepart = ref<{ sceneId: string; label: string; at: string } | null>(null);
const departsPasses = ref<
  { at: string; label: string; origin: string; total: number; echecs: number; refus: string | null }[]
>([]);

async function relireScenes() {
  try {
    const [n, h] = await Promise.all([
      fetch('/api/scenes/next').then((r) => r.json()),
      fetch('/api/scenes/history?limit=8').then((r) => r.json()),
    ]);
    prochainDepart.value = n.next ?? null;
    departsPasses.value = h.runs ?? [];
  } catch {
    prochainDepart.value = null;
    departsPasses.value = [];
  }
}
onMounted(relireScenes);

/** « samedi 26 à 07:00 », dans le fuseau de la maison. */
function quand(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: draft.value?.house.timezone ?? 'Europe/Paris',
    weekday: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

async function relirePont() {
  try {
    pont.value = await (await fetch('/api/homekit')).json();
  } catch {
    pont.value = null;
  }
}
onMounted(relirePont);

/** Brouillon local : on n'enregistre que sur action explicite. */
const draft = ref<HouseConfig | null>(null);
const saving = ref(false);
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

watch(() => house.config, (c) => { if (c && !draft.value) draft.value = copie(c); }, { immediate: true });

const dirty = computed(
  () => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(house.config),
);

async function save() {
  if (!draft.value) return;
  saving.value = true;
  message.value = null;
  try {
    const warnings = await house.saveConfig(draft.value);
    message.value = {
      kind: 'ok',
      text: warnings.length
        ? `Enregistré. ${warnings.map((w: any) => w.message).join(' ')}`
        : 'Enregistré. Le driver a redémarré.',
    };
  } catch (e) {
    message.value = { kind: 'err', text: (e as Error).message };
  } finally {
    saving.value = false;
    // Le pont a pu s'ouvrir, se fermer ou refuser : on redemande son état réel
    // plutôt que de déduire de la case cochée.
    await relirePont();
    await relireScenes();
  }
}

function revert() {
  draft.value = house.config ? copie(house.config) : null;
  message.value = null;
}

async function reset() {
  if (!confirm('Remettre la maison de référence ? Tout le paramétrage actuel sera perdu.')) return;
  await house.resetConfig();
  revert();
}

// -------------------------------------------------------------------- zones

function addZone() {
  if (!draft.value) return;
  const n = draft.value.zones.length;
  draft.value.zones.push({
    id: `z${String(n + 30).padStart(2, '0')}`,
    label: 'Nouvelle zone',
    kind: 'living',
    order: n,
    heated: true,
  });
}

function removeZone(id: string) {
  if (!draft.value) return;
  const count = draft.value.devices.filter((d) => d.zoneId === id).length;
  if (count && !confirm(`Cette zone contient ${count} équipement(s). Les supprimer aussi ?`)) return;
  draft.value.zones = draft.value.zones.filter((z) => z.id !== id);
  draft.value.devices = draft.value.devices.filter((d) => d.zoneId !== id);
}

// -------------------------------------------------------------- equipements

const zoneFilter = ref<string>('*');

const filteredDevices = computed(() => {
  if (!draft.value) return [];
  const list = zoneFilter.value === '*'
    ? draft.value.devices
    : draft.value.devices.filter((d) => d.zoneId === zoneFilter.value);
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
});

const unbound = computed(() => draft.value?.devices.filter((d) => !d.binding).length ?? 0);

function addDevice() {
  if (!draft.value) return;
  const zoneId = zoneFilter.value === '*' ? (draft.value.zones[0]?.id ?? 'z00') : zoneFilter.value;
  draft.value.devices.push({
    id: `${zoneId}.light.nouveau-${Date.now().toString(36).slice(-4)}`,
    zoneId,
    label: 'Nouvel équipement',
    type: 'light',
    order: draft.value.devices.filter((d) => d.zoneId === zoneId).length,
    staleAfterSeconds: 300,
    binding: null,
    sim: {},
  });
}

function removeDevice(id: string) {
  if (!draft.value) return;
  draft.value.devices = draft.value.devices.filter((d) => d.id !== id);
}

/** Santé des canaux, poussée en temps réel par le serveur. */
const canaux = computed<ConnectionStatus[]>(() => house.connections);

// ------------------------------------------------------------- connectivité

const candidats = ref<Candidate[]>([]);
const presets = ref<Preset[]>([]);
let veille: number | null = null;

/**
 * La découverte se rafraîchit tant qu'on est sur l'écran : un module qu'on
 * vient de brancher doit apparaître sans qu'on ait à recharger la page.
 */
async function rafraichirDecouverte() {
  try {
    const r = await fetch('/api/discovery');
    candidats.value = (await r.json()).candidates ?? [];
  } catch { /* le bandeau hors ligne le dit déjà */ }
}

onMounted(async () => {
  const r = await fetch('/api/presets').catch(() => null);
  if (r?.ok) presets.value = (await r.json()).presets ?? [];
  await rafraichirDecouverte();
  veille = window.setInterval(rafraichirDecouverte, 4000);
});
onBeforeUnmount(() => { if (veille) clearInterval(veille); });

const NOUVEAU_CANAL = {
  mqtt: {
    nom: 'Broker MQTT',
    settings: () => ({ url: '', username: '', password: '', baseTopic: 'domo' }),
  },
  http: {
    nom: 'API HTTP',
    settings: () => ({ baseUrl: '', headers: {}, pollSeconds: 30 }),
  },
  modbus: {
    nom: 'Modbus TCP',
    // Port 502 et esclave 1 sont les valeurs de la quasi-totalité du matériel.
    // Le balayage reste à zéro : on ne lit pas une plage de registres chez
    // quelqu'un sans qu'il l'ait demandé.
    settings: () => ({
      host: '', port: 502, unitId: 1, pollSeconds: 10,
      scanTable: 'holding', scanFrom: 0, scanCount: 0,
    }),
  },
} as const;

function ajouterConnexion(kind: keyof typeof NOUVEAU_CANAL) {
  if (!draft.value) return;
  const modele = NOUVEAU_CANAL[kind];
  const n = draft.value.connections.filter((c) => c.kind === kind).length + 1;
  draft.value.connections.push({
    id: `${kind}${n > 1 ? n : ''}`,
    kind,
    label: `${modele.nom}${n > 1 ? ' ' + n : ''}`,
    enabled: false,
    settings: modele.settings(),
  } as Connection);
}

function retirerConnexion(id: string) {
  if (!draft.value) return;
  const utilises = draft.value.devices.filter((d) => d.binding?.connectionId === id).length;
  if (utilises && !confirm(`${utilises} équipement(s) utilisent ce canal. Ils repasseront en simulé.`)) return;
  draft.value.connections = draft.value.connections.filter((c) => c.id !== id);
  draft.value.devices = draft.value.devices.map((d) =>
    d.binding?.connectionId === id ? { ...d, binding: null } : d,
  );
}

async function viderDecouverte() {
  await fetch('/api/discovery', { method: 'DELETE' });
  candidats.value = [];
}

const TYPES = Object.keys(DEVICE_TYPE_LABELS) as DeviceType[];
const METRICS = Object.keys(METRIC_LABELS) as Metric[];
const KINDS = Object.keys(ZONE_KIND_LABELS) as ZoneKind[];
</script>

<template>
  <div v-if="draft" class="space-y-5 pb-32">
    <header>
      <h1 class="text-[26px] font-semibold leading-tight tracking-tight">Paramétrage</h1>
      <p class="mt-1.5 text-sm text-soft">
        Tout se règle ici. Aucune zone, aucun équipement n'est écrit en dur dans le code.
      </p>
    </header>

    <nav class="flex gap-1 overflow-x-auto rounded-2xl border border-line bg-raised p-1">
      <button
        v-for="o in ONGLETS"
        :key="o.id"
        class="press flex-1 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-medium transition-colors"
        :class="tab === o.id ? 'bg-surface text-ink shadow-card' : 'text-soft hover:text-ink'"
        @click="tab = o.id"
      >{{ o.libelle }}</button>
    </nav>

    <!-- ===================================================== MAISON -->
    <section v-if="tab === 'maison'" class="grid gap-4 xl:grid-cols-2 xl:items-start">
      <div class="card">
        <h2 class="card-title">Identité</h2>
        <label class="field">
          <span>Nom</span>
          <input v-model="draft.house.name" class="input" />
        </label>
        <label class="field">
          <span>Fuseau horaire</span>
          <input v-model="draft.house.timezone" class="input" />
        </label>
      </div>

      <div class="card">
        <h2 class="card-title">Chauffage</h2>
        <p class="hint">
          Régulation unique aujourd'hui : la maison n'a pas d'émetteur pilotable par pièce.
          Basculer sur « zoné » le jour où elle en aura — le modèle est déjà prêt, il n'y aura
          rien à réécrire.
        </p>
        <label class="field">
          <span>Mode</span>
          <select v-model="draft.heating.mode" class="input">
            <option value="single">Unique — toute la maison</option>
            <option value="zoned">Zoné — un émetteur par pièce</option>
          </select>
        </label>
        <label class="field">
          <span>Type d'émetteur</span>
          <select v-model="draft.heating.emitter" class="input">
            <option value="unknown">À déterminer</option>
            <option value="air">Air soufflé — inertie faible</option>
            <option value="water">Radiateurs à eau — inertie moyenne</option>
            <option value="floor">Plancher chauffant — forte inertie</option>
          </select>
        </label>
        <p class="hint">
          Détermine l'inertie simulée, donc l'agressivité des réduits nocturnes.
        </p>
        <div class="grid grid-cols-2 gap-3">
          <label class="field">
            <span>Consigne min.</span>
            <input v-model.number="draft.heating.minSetpoint" type="number" step="0.5" class="input" />
          </label>
          <label class="field">
            <span>Consigne max.</span>
            <input v-model.number="draft.heating.maxSetpoint" type="number" step="0.5" class="input" />
          </label>
          <label class="field">
            <span>Réduit nocturne (°C)</span>
            <input v-model.number="draft.heating.nightSetback" type="number" step="0.5" class="input" />
          </label>
          <label class="field">
            <span>Consigne absence</span>
            <input v-model.number="draft.heating.awaySetpoint" type="number" step="0.5" class="input" />
          </label>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">Piscine</h2>
        <p class="hint">
          L'application lit, historise et alerte. Elle ne commande jamais l'injection de produit —
          cette boucle reste sur un régulateur autonome, avec ses sécurités câblées.
        </p>
        <label class="flex items-center gap-2 py-1">
          <input v-model="draft.pool.enabled" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
          <span class="text-sm">Bassin suivi</span>
        </label>
        <label class="field">
          <span>Traitement</span>
          <select v-model="draft.pool.treatment" class="input">
            <option value="unknown">À déterminer</option>
            <option value="chlore">Chlore</option>
            <option value="sel">Sel</option>
            <option value="brome">Brome</option>
          </select>
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="field">
            <span>pH min.</span>
            <input v-model.number="draft.pool.phTarget[0]" type="number" step="0.1" class="input" />
          </label>
          <label class="field">
            <span>pH max.</span>
            <input v-model.number="draft.pool.phTarget[1]" type="number" step="0.1" class="input" />
          </label>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">Énergie</h2>
        <p class="hint">
          Un seul compteur mesure la maison entière. La part du chauffage ou de
          la cuisine ne s'en déduit pas — il faudrait une mesure par circuit.
        </p>

        <label class="flex items-center gap-2 text-sm">
          <input v-model="draft.energy.visible" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
          <span>Afficher l'écran Énergie dans le menu</span>
        </label>
        <p class="hint">
          Décoché, l'écran quitte le menu mais reste joignable par son adresse.
          À laisser fermé tant qu'aucun compteur n'est branché : un graphique
          vide ne sert personne.
        </p>

        <label class="field">
          <span>Compteur général</span>
          <select v-model="draft.energy.meterDeviceId" class="input">
            <option value="">Aucun — pas de suivi</option>
            <option v-for="d in compteurs" :key="d.id" :value="d.id">{{ d.label }}</option>
          </select>
        </label>

        <label class="field">
          <span>Prix du kWh, toutes taxes comprises</span>
          <input
            v-model.number="draft.energy.pricePerKwh" type="number" min="0" step="0.001"
            class="input" placeholder="0,2016"
          />
        </label>
        <p class="hint">
          Laissé à zéro, l'écran Énergie n'affiche aucun montant plutôt qu'un
          montant inventé. Le prix est un tarif unique : il ignore l'abonnement,
          les heures creuses et les taxes fixes, donc il ne fera pas la facture.
        </p>
      </div>

      <div class="card xl:col-span-2">
        <h2 class="card-title">Pont HomeKit</h2>
        <p class="hint">
          Ouvre la maison à l'app Maison d'Apple, donc à Siri, aux automatisations
          et aux autres habitants. Le pont ne fait que relayer : il lit l'état du
          cerveau et lui transmet les commandes, exactement comme cette page.
        </p>

        <label class="flex items-center gap-2 text-sm">
          <input v-model="draft.homekit.enabled" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
          <span>Ouvrir le pont</span>
        </label>

        <div class="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <label class="field">
            <span>Nom dans l'app Maison</span>
            <input v-model="draft.homekit.name" class="input" placeholder="Maison" />
          </label>
          <label class="field">
            <span>Code d'association</span>
            <input v-model="draft.homekit.pin" class="input w-36 font-mono" placeholder="031-45-154" />
          </label>
          <label class="field">
            <span>Port</span>
            <input v-model.number="draft.homekit.port" type="number" class="input w-24" />
          </label>
        </div>
        <p class="hint">
          Le code est ce qu'on tape sur l'iPhone pour associer la maison. Change-le :
          celui d'usine circule partout.
        </p>

        <div v-if="pont" class="space-y-2 border-t border-line pt-3">
          <p v-if="pont.published" class="text-sm">
            <span class="font-medium text-ok">Pont ouvert</span> ·
            {{ pont.exposes }} accessoires visibles dans l'app Maison.
            <span v-if="pont.pin">Code : <span class="font-mono">{{ pont.pin }}</span></span>
          </p>
          <p v-else-if="pont.error" class="text-sm text-crit">Le pont n'a pas pu s'ouvrir : {{ pont.error }}</p>
          <p v-else class="text-sm text-soft">Pont fermé.</p>

          <details v-if="pont.skipped.length" class="text-xs text-soft">
            <summary class="cursor-pointer">
              {{ pont.skipped.length }} équipement(s) ne peuvent pas être exposés
            </summary>
            <ul class="mt-1.5 space-y-1 pl-4">
              <li v-for="e in pont.skipped" :key="e.label">
                <strong>{{ e.label }}</strong> — {{ e.raison }}
              </li>
            </ul>
            <p class="mt-1.5">
              HomeKit n'a pas de service pour ces grandeurs. Les déguiser en autre
              chose donnerait des relevés absurdes : elles restent ici, où elles
              s'affichent correctement.
            </p>
          </details>
        </div>
      </div>

      <button class="press inline-flex min-h-[28px] items-center text-sm font-medium text-crit underline" @click="reset">
        Remettre la maison de référence
      </button>
    </section>

    <!-- ====================================================== ZONES -->
    <section v-if="tab === 'zones'" class="space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-sm text-soft">{{ draft.zones.length }} zones</p>
        <button class="btn" @click="addZone">+ Ajouter</button>
      </div>

      <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      <div v-for="z in draft.zones" :key="z.id" class="card space-y-2">
        <div class="flex items-center gap-2">
          <input v-model="z.label" class="input flex-1 font-medium" aria-label="Nom de la zone" />
          <button
            class="press shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-crit" aria-label="Supprimer la zone"
            @click="removeZone(z.id)"
          >Suppr.</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="field">
            <span>Identifiant</span>
            <input v-model="z.id" class="input font-mono text-xs" />
          </label>
          <label class="field">
            <span>Nature</span>
            <select v-model="z.kind" class="input">
              <option v-for="k in KINDS" :key="k" :value="k">{{ ZONE_KIND_LABELS[k] }}</option>
            </select>
          </label>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="z.heated" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
          <span>Pièce chauffée</span>
        </label>
        <p class="hint">
          {{ z.plan?.length ? `${z.plan.length} emprise(s) sur le plan` : 'Pas d’emprise — n’apparaît pas sur le plan' }}
          · {{ draft.devices.filter(d => d.zoneId === z.id).length }} équipements
        </p>
      </div>
      </div>
    </section>

    <!-- ================================================ EQUIPEMENTS -->
    <section v-if="tab === 'equipements'" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="zoneFilter" class="input flex-1" aria-label="Filtrer par zone">
          <option value="*">Toutes les zones ({{ draft.devices.length }})</option>
          <option v-for="z in draft.zones" :key="z.id" :value="z.id">
            {{ z.label }} ({{ draft.devices.filter(d => d.zoneId === z.id).length }})
          </option>
        </select>
        <button class="btn" @click="addDevice">+ Ajouter</button>
      </div>

      <p v-if="unbound" class="rounded-xl border border-warn/40 bg-warn/[0.08] px-3.5 py-2.5 text-xs text-warn-deep">
        {{ unbound }} équipement(s) non raccordés au matériel — ils restent simulés.
      </p>

      <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      <div v-for="d in filteredDevices" :key="d.id" class="card space-y-2">
        <div class="flex items-center gap-2">
          <input v-model="d.label" class="input flex-1 font-medium" aria-label="Nom de l'équipement" />
          <span
            class="shrink-0 rounded-md px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider"
            :class="d.binding ? 'bg-ok/15 text-ok' : 'bg-ink/[0.07] text-faint'"
          >{{ d.binding ? 'raccordé' : 'simulé' }}</span>
          <button class="press shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-crit" @click="removeDevice(d.id)">Suppr.</button>
        </div>

        <input v-model="d.id" class="input w-full font-mono text-[11px]" aria-label="Identifiant" />

        <div class="grid grid-cols-2 gap-2">
          <label class="field">
            <span>Zone</span>
            <select v-model="d.zoneId" class="input">
              <option v-for="z in draft.zones" :key="z.id" :value="z.id">{{ z.label }}</option>
            </select>
          </label>
          <label class="field">
            <span>Type</span>
            <select v-model="d.type" class="input">
              <option v-for="t in TYPES" :key="t" :value="t">{{ DEVICE_TYPE_LABELS[t] }}</option>
            </select>
          </label>
          <label v-if="d.type === 'sensor'" class="field">
            <span>Grandeur</span>
            <select v-model="d.metric" class="input">
              <option v-for="m in METRICS" :key="m" :value="m">{{ METRIC_LABELS[m] }}</option>
            </select>
          </label>
          <label v-if="d.type === 'cover'" class="field">
            <span>Course (s)</span>
            <input v-model.number="d.sim.travelSeconds" type="number" class="input" />
          </label>
          <label class="field">
            <span>Périmé après (s)</span>
            <input v-model.number="d.staleAfterSeconds" type="number" class="input" />
          </label>
        </div>

        <WiringEditor
          :device="d"
          :connections="draft.connections"
          :candidates="candidats"
          :presets="presets"
        />
      </div>
      </div>
    </section>

    <!-- ==================================================== SCENES -->
    <!-- =================================================== CAMERAS -->
    <section v-if="tab === 'cameras'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <p class="hint flex-1">
          Des images fixes rafraîchies, pas un flux vidéo. Le serveur va chercher
          l'image et la relaie : les identifiants ne quittent jamais la maison.
        </p>
        <button class="btn" @click="ajouterCamera">+ Ajouter</button>
      </div>

      <p class="rounded-xl border border-warn/40 bg-warn/[0.08] px-3.5 py-2.5 text-xs text-warn-deep">
        Le serveur n'a aucune authentification. Allumer une caméra rend ses
        images accessibles à toute machine du réseau local qui connaît son
        adresse. C'est acceptable chez soi, à condition de le savoir.
      </p>

      <div v-if="!(draft.cameras ?? []).length" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-soft">
        Aucune caméra. L'écran Caméras n'apparaît dans le menu qu'une fois la
        première déclarée.
      </div>

      <div class="grid gap-4 xl:grid-cols-2 xl:items-start">
        <div v-for="c in draft.cameras" :key="c.id" class="card space-y-3">
          <div class="flex items-center gap-2">
            <input v-model="c.label" class="input flex-1 font-medium" aria-label="Nom de la caméra" />
            <button
              class="press shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-crit"
              :aria-label="`Supprimer ${c.label}`" @click="retirerCamera(c.id)"
            >Suppr.</button>
          </div>

          <label class="field">
            <span>Adresse de l'image fixe</span>
            <input
              v-model="c.snapshotUrl" class="input font-mono text-xs"
              placeholder="http://192.168.1.90/cgi-bin/snapshot.cgi"
            />
          </label>
          <p class="hint">
            L'adresse de l'INSTANTANÉ, pas celle de la page web de la caméra.
            Elle finit souvent par snapshot.cgi, snap.jpg ou image.jpg.
          </p>

          <div class="grid grid-cols-2 gap-2">
            <label class="field">
              <span>Utilisateur</span>
              <input v-model="c.username" class="input" autocomplete="off" />
            </label>
            <label class="field">
              <span>Mot de passe</span>
              <input v-model="c.password" type="password" class="input" autocomplete="new-password" />
            </label>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <label class="field">
              <span>Pièce</span>
              <select v-model="c.zoneId" class="input">
                <option value="">Extérieur ou non rattachée</option>
                <option v-for="z in draft.zones" :key="z.id" :value="z.id">{{ z.label }}</option>
              </select>
            </label>
            <label class="field">
              <span>Rafraîchissement (secondes)</span>
              <input v-model.number="c.refreshSeconds" type="number" min="1" max="3600" class="input" />
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <label class="flex items-center gap-2 text-sm">
              <input v-model="c.enabled" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
              <span>{{ c.enabled ? 'Active' : 'Au repos' }}</span>
            </label>
            <button
              class="press ml-auto rounded-lg bg-ink/[0.06] px-3 py-1.5 text-xs font-medium"
              @click="testerCamera(c.id)"
            >Tester</button>
          </div>

          <p
            v-if="essais[c.id]"
            class="rounded-lg px-3 py-2 text-xs"
            :class="essais[c.id]!.etat === 'ok' ? 'bg-ok/10 text-ok'
              : essais[c.id]!.etat === 'ko' ? 'bg-crit/10 text-crit' : 'bg-ink/[0.05] text-soft'"
          >{{ essais[c.id]!.texte }}</p>
        </div>
      </div>
    </section>

    <!-- ================================================== MATERIEL -->
    <section v-if="tab === 'materiel'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <p class="hint flex-1">
          Plusieurs canaux tournent en même temps. Chaque équipement choisit le sien ;
          tout ce qui n'est pas raccordé reste servi par le simulateur.
        </p>
        <button class="press rounded-lg bg-ink/[0.06] px-3 py-2 text-sm font-medium" @click="ajouterConnexion('mqtt')">
          + Broker MQTT
        </button>
        <button class="press rounded-lg bg-ink/[0.06] px-3 py-2 text-sm font-medium" @click="ajouterConnexion('http')">
          + API HTTP
        </button>
        <button class="press rounded-lg bg-ink/[0.06] px-3 py-2 text-sm font-medium" @click="ajouterConnexion('modbus')">
          + Modbus TCP
        </button>
      </div>

      <div class="grid gap-4 xl:grid-cols-2 xl:items-start">
        <ConnectionCard
          v-for="c in draft.connections" :key="c.id"
          :connection="c"
          :status="canaux.find((s) => s.id === c.id)"
          :removable="c.kind !== 'sim'"
          @remove="retirerConnexion(c.id)"
        />
      </div>

      <div class="grid gap-4 xl:grid-cols-2 xl:items-start">
        <div class="card">
          <div class="flex items-center justify-between">
            <h2 class="card-title">Sur le réseau</h2>
            <button v-if="candidats.length" class="press text-xs font-medium text-soft" @click="viderDecouverte">
              Vider
            </button>
          </div>
          <p class="hint">
            Ce que les canaux ont entendu sans savoir à qui l'attribuer. On n'oblige
            jamais à deviner un topic : on écoute, et on propose.
          </p>
          <div v-if="!candidats.length" class="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-soft">
            Rien pour l'instant. Active un canal MQTT et branche un module.
          </div>
          <div v-for="c in candidats.slice(0, 20)" :key="c.key" class="rounded-lg border border-line p-2.5">
            <div class="flex items-baseline justify-between gap-2">
              <p class="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">{{ c.source }}</p>
              <span class="label shrink-0">{{ c.count }} msg</span>
            </div>
            <p class="mt-1 truncate font-mono text-[10px] text-faint">{{ c.sample }}</p>
          </div>
        </div>

        <div class="card">
          <h2 class="card-title">Répartition</h2>
          <dl class="space-y-1 font-mono text-xs">
            <div class="flex justify-between"><dt class="text-faint">Équipements</dt><dd>{{ draft.devices.length }}</dd></div>
            <div class="flex justify-between"><dt class="text-faint">Raccordés</dt><dd>{{ draft.devices.length - unbound }}</dd></div>
            <div class="flex justify-between"><dt class="text-faint">Simulés</dt><dd>{{ unbound }}</dd></div>
            <div class="flex justify-between"><dt class="text-faint">Canaux actifs</dt><dd>{{ canaux.filter((c) => c.state === 'connected').length }}</dd></div>
            <div class="flex justify-between"><dt class="text-faint">Découverts</dt><dd>{{ candidats.length }}</dd></div>
          </dl>
          <p class="hint">
            Un équipement simulé n'est pas une anomalie : c'est ce qui permet
            d'équiper la maison pièce par pièce, en vivant avec le mélange.
          </p>
        </div>
      </div>
    </section>

    <!-- barre d'enregistrement -->
    <div
      v-if="dirty || message"
      class="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 p-3 backdrop-blur-xl"
    >
      <div class="mx-auto flex w-full max-w-[1500px] items-center gap-3 px-1 lg:px-10">
        <p
          class="min-w-0 flex-1 truncate text-sm"
          :class="message?.kind === 'err' ? 'text-crit' : 'text-soft'"
        >{{ message?.text ?? 'Modifications non enregistrées' }}</p>
        <button v-if="dirty" class="text-sm text-soft" @click="revert">Annuler</button>
        <button v-if="dirty" class="btn" :disabled="saving" @click="save">
          {{ saving ? 'Enregistrement…' : 'Enregistrer' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card { @apply space-y-3 rounded-2xl border border-line bg-surface p-4; }
.card-title { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.field { @apply block space-y-1.5; }
.field > span { @apply block text-xs text-soft; }
.input {
  @apply w-full rounded-xl border border-line bg-ground px-3.5 py-2.5 text-sm text-ink
         outline-none transition-colors placeholder:text-faint focus:border-glow;
}
.hint { @apply text-xs leading-relaxed text-soft; }
.btn {
  @apply shrink-0 rounded-xl bg-glow-deep px-4 py-2.5 text-sm font-semibold text-surface
         transition-transform duration-150 ease-swift active:scale-[0.97] disabled:opacity-50;
}
</style>
