<script setup lang="ts">
/**
 * Le câblage d'un équipement.
 *
 * C'est ici que « brancher n'importe quoi » devient concret : on déclare d'où
 * vient chaque information et où atterrit chaque commande, avec une petite
 * chaîne de transformations entre les deux.
 *
 * Trois chemins possibles, du plus rapide au plus précis :
 *   · un pré-réglage (Shelly, Zigbee2MQTT…) qui remplit tout d'un coup ;
 *   · un candidat repéré sur le réseau, dont les champs sont déjà connus ;
 *   · la saisie manuelle, pour le matériel exotique.
 */
import { computed, ref } from 'vue';
import {
  CAP_FIELD_LABELS, FIELDS_BY_CAPABILITY, TRANSFORM_LABELS, capabilitiesFor,
  type CapField, type Candidate, type Connection, type DeviceConfig,
  type Preset, type Transform, type TransformOp,
} from '@domo/shared';
import Icon from './Icon.vue';

const props = defineProps<{
  device: DeviceConfig;
  connections: Connection[];
  candidates: Candidate[];
  presets: Preset[];
}>();

const d = computed(() => props.device);
const canaux = computed(() => props.connections.filter((c) => c.kind !== 'sim'));

/** Les cases du modèle qui ont un sens pour CE type d'équipement. */
const champsPossibles = computed<CapField[]>(() =>
  capabilitiesFor(d.value.type).flatMap((k) => FIELDS_BY_CAPABILITY[k]),
);

const COMMANDES = computed(() => {
  const t = d.value.type;
  if (t === 'cover') return ['cover', 'cover-stop'] as const;
  if (t === 'dimmer') return ['switch', 'dim'] as const;
  if (t === 'thermostat') return ['climate'] as const;
  if (t === 'sensor') return [] as const;
  return ['switch'] as const;
});

function raccorder() {
  const cible = canaux.value[0];
  if (!cible) return;
  d.value.binding = { connectionId: cible.id, reads: [], writes: [] };
  ajouterLecture();
}

function ajouterLecture() {
  d.value.binding?.reads.push({
    source: '', path: '',
    into: champsPossibles.value[0] ?? 'switch.state',
    pipeline: [],
  });
}

function ajouterEcriture() {
  const cmd = COMMANDES.value[0];
  if (!cmd) return;
  d.value.binding?.writes.push({
    on: cmd, target: '', payload: '{{valeur}}', pipeline: [], method: 'POST',
  });
}

// ------------------------------------------------------------ pré-réglages

const presetChoisi = ref('');
const identifiant = ref('');

const presetsUtiles = computed(() => {
  const kinds = new Set(canaux.value.map((c) => c.kind));
  return props.presets.filter((p) => kinds.has(p.kind));
});

const presetActif = computed(() => props.presets.find((p) => p.id === presetChoisi.value));

/**
 * Applique un pré-réglage. `{id}` est remplacé par l'identifiant du module : * c'est la seule chose que l'utilisateur ait à connaître.
 */
function appliquerPreset() {
  const p = presetActif.value;
  const cible = canaux.value.find((c) => c.kind === p?.kind);
  if (!p || !cible || !identifiant.value.trim()) return;

  const id = identifiant.value.trim().replace(/^\/+|\/+$/g, '');
  const sub = (s: string) => s.replaceAll('{id}', id);

  d.value.binding = {
    connectionId: cible.id,
    reads: p.reads
      .filter((r) => champsPossibles.value.includes(r.into as CapField))
      .map((r) => ({ ...r, source: sub(r.source), into: r.into as CapField, pipeline: [...r.pipeline] })),
    writes: p.writes.map((w) => ({
      ...w, target: sub(w.target), on: w.on as 'switch',
      pipeline: [...w.pipeline], method: 'POST' as const,
    })),
  };
  presetChoisi.value = '';
  identifiant.value = '';
}

// -------------------------------------------------------------- découverte

const ouvrirCandidats = ref(false);

/** Les candidats du canal choisi, les plus bavards d'abord. */
const candidatsUtiles = computed(() =>
  props.candidates.filter((c) => c.connectionId === d.value.binding?.connectionId).slice(0, 25),
);

/** Un clic sur un champ repéré crée la lecture correspondante. */
function adopter(candidat: Candidate, path: string) {
  d.value.binding?.reads.push({
    source: candidat.source,
    path,
    into: champsPossibles.value[0] ?? 'sensor.value',
    pipeline: [{ op: 'number' }],
  });
  ouvrirCandidats.value = false;
}

// --------------------------------------------------------- transformations

const OPS: TransformOp[] = ['number', 'bool', 'scale', 'round', 'clamp', 'invert', 'map'];

/**
 * Le jeton de substitution, en constante : écrit tel quel dans le gabarit, le
 * compilateur Vue le prendrait pour une interpolation et refuserait le fichier.
 */
const JETON = '{{valeur}}';

function neuve(op: TransformOp): Transform {
  switch (op) {
    case 'number': return { op: 'number' };
    case 'bool': return { op: 'bool', truthy: [] };
    case 'scale': return { op: 'scale', factor: 1, offset: 0 };
    case 'round': return { op: 'round', decimals: 1 };
    case 'clamp': return { op: 'clamp', min: 0, max: 100 };
    case 'invert': return { op: 'invert', span: 100 };
    case 'map': return { op: 'map', table: {} };
  }
}

function changerOp(liste: Transform[], i: number, op: TransformOp) {
  liste[i] = neuve(op);
}

/** La table de correspondance s'édite en texte : `ON = true`, une ligne par entrée. */
function tableVersTexte(t: Record<string, string | number | boolean>): string {
  return Object.entries(t).map(([k, v]) => `${k} = ${v}`).join('\n');
}

function texteVersTable(texte: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const ligne of texte.split('\n')) {
    const i = ligne.indexOf('=');
    if (i < 0) continue;
    const cle = ligne.slice(0, i).trim();
    const brut = ligne.slice(i + 1).trim();
    if (!cle) continue;
    out[cle] = brut === 'true' ? true : brut === 'false' ? false
      : brut !== '' && Number.isFinite(Number(brut)) ? Number(brut) : brut;
  }
  return out;
}
</script>

<template>
  <div class="space-y-3">
    <!-- pas encore raccordé -->
    <div v-if="!d.binding" class="space-y-2 rounded-xl border border-dashed border-line p-3">
      <p class="hint">
        Cet équipement est <strong>simulé</strong>. Il fonctionne, mais rien de réel
        ne lui répond.
      </p>
      <button
        v-if="canaux.length"
        class="press w-full rounded-lg bg-glow/10 py-2 text-sm font-medium text-glow-deep"
        @click="raccorder"
      >Raccorder à un canal</button>
      <p v-else class="text-xs text-warn">
        Ajoute d'abord un canal MQTT ou HTTP dans l'onglet Matériel.
      </p>
    </div>

    <!-- raccordé -->
    <div v-else class="space-y-3 rounded-xl border border-line bg-ground p-3">
      <div class="flex items-center gap-2">
        <select v-model="d.binding.connectionId" class="input flex-1" aria-label="Canal">
          <option v-for="c in canaux" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <button class="press rounded-lg px-2 py-1.5 text-xs font-medium text-crit" @click="d.binding = null">
          Détacher
        </button>
      </div>

      <!-- pré-réglages : le chemin le plus court -->
      <div class="space-y-2 rounded-lg bg-surface p-2.5">
        <p class="label">Pré-réglage</p>
        <select v-model="presetChoisi" class="input">
          <option value="">Câblage manuel</option>
          <option v-for="p in presetsUtiles" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <template v-if="presetActif">
          <p class="hint">{{ presetActif.hint }}</p>
          <div class="flex gap-2">
            <input
              v-model="identifiant" class="input flex-1 font-mono text-sm"
              placeholder="identifiant du module"
              @keydown.enter="appliquerPreset"
            />
            <button
              class="press shrink-0 rounded-lg bg-glow-deep px-3 text-sm font-semibold text-surface disabled:opacity-40"
              :disabled="!identifiant.trim()" @click="appliquerPreset"
            >Appliquer</button>
          </div>
        </template>
      </div>

      <!-- lectures -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="label">Lectures, d'où vient l'état</p>
          <div class="flex gap-1">
            <button
              v-if="candidatsUtiles.length"
              class="press rounded-md bg-jour/15 px-2 py-1 text-[11px] font-medium text-jour"
              @click="ouvrirCandidats = !ouvrirCandidats"
            >Sur le réseau ({{ candidatsUtiles.length }})</button>
            <button class="press rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] font-medium" @click="ajouterLecture">
              + Lecture
            </button>
          </div>
        </div>

        <!-- découverte -->
        <div v-if="ouvrirCandidats" class="max-h-64 space-y-2 overflow-y-auto rounded-lg bg-surface p-2">
          <p class="hint">Ce que ce canal a entendu passer. Touchez un champ pour le brancher.</p>
          <div v-for="c in candidatsUtiles" :key="c.key" class="rounded-lg border border-line p-2">
            <p class="font-mono text-[11px] font-medium">{{ c.source }}</p>
            <p class="label mt-0.5">{{ c.count }} message(s)</p>
            <div class="mt-1.5 flex flex-wrap gap-1">
              <button
                v-for="p in c.paths" :key="p.path"
                class="press rounded-md bg-ink/[0.06] px-2 py-1 text-left font-mono text-[10px] hover:bg-glow/15"
                @click="adopter(c, p.path)"
              >{{ p.path || '(brut)' }} = {{ p.sample }}</button>
            </div>
          </div>
        </div>

        <div v-for="(r, i) in d.binding.reads" :key="i" class="space-y-2 rounded-lg bg-surface p-2.5">
          <div class="flex items-center gap-2">
            <span class="label flex-1">Lecture {{ i + 1 }}</span>
            <button class="press text-[11px] text-crit" @click="d.binding.reads.splice(i, 1)">Retirer</button>
          </div>
          <input v-model="r.source" class="input font-mono text-xs" placeholder="topic ou point d'entrée" />
          <div class="grid grid-cols-2 gap-2">
            <input v-model="r.path" class="input font-mono text-xs" placeholder="chemin JSON (vide = brut)" />
            <select v-model="r.into" class="input text-xs">
              <option v-for="f in champsPossibles" :key="f" :value="f">{{ CAP_FIELD_LABELS[f] }}</option>
            </select>
          </div>

          <!-- chaîne de transformation -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="label">Transformations</span>
              <select
                class="rounded-md border border-line bg-ground px-2 py-1 text-[11px]"
                :value="''"
                @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) r.pipeline.push(neuve(v as TransformOp)); (e.target as HTMLSelectElement).value = ''; }"
              >
                <option value="">+ Ajouter</option>
                <option v-for="op in OPS" :key="op" :value="op">{{ TRANSFORM_LABELS[op] }}</option>
              </select>
            </div>
            <div
              v-for="(t, ti) in r.pipeline" :key="ti"
              class="flex flex-wrap items-center gap-1.5 rounded-md bg-ink/[0.04] px-2 py-1.5"
            >
              <select
                class="rounded border border-line bg-ground px-1.5 py-1 text-[11px]"
                :value="t.op"
                @change="(e) => changerOp(r.pipeline, ti, (e.target as HTMLSelectElement).value as TransformOp)"
              >
                <option v-for="op in OPS" :key="op" :value="op">{{ TRANSFORM_LABELS[op] }}</option>
              </select>

              <template v-if="t.op === 'scale'">
                <input v-model.number="t.factor" type="number" step="any" class="w-16 mini" aria-label="Facteur" />
                <span class="text-[11px] text-faint">×, puis +</span>
                <input v-model.number="t.offset" type="number" step="any" class="w-16 mini" aria-label="Décalage" />
              </template>
              <input v-if="t.op === 'round'" v-model.number="t.decimals" type="number" min="0" max="4" class="w-14 mini" aria-label="Décimales" />
              <template v-if="t.op === 'clamp'">
                <input v-model.number="t.min" type="number" class="w-16 mini" aria-label="Minimum" />
                <input v-model.number="t.max" type="number" class="w-16 mini" aria-label="Maximum" />
              </template>
              <input v-if="t.op === 'invert'" v-model.number="t.span" type="number" class="w-16 mini" aria-label="Amplitude" />
              <input
                v-if="t.op === 'bool'" class="mini flex-1" placeholder="valeurs vraies : ON, 1"
                :value="t.truthy.join(', ')"
                @change="(e) => (t.truthy = (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean))"
              />
              <textarea
                v-if="t.op === 'map'" rows="2" class="mini w-full font-mono" placeholder="ON = true&#10;OFF = false"
                :value="tableVersTexte(t.table)"
                @change="(e) => (t.table = texteVersTable((e.target as HTMLTextAreaElement).value))"
              />

              <button class="press ml-auto grid h-6 w-6 place-items-center rounded text-[11px] text-crit" @click="r.pipeline.splice(ti, 1)">×</button>
            </div>
          </div>
        </div>
      </div>

      <!-- écritures -->
      <div v-if="COMMANDES.length" class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="label">Écritures : où partent les commandes</p>
          <button class="press rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] font-medium" @click="ajouterEcriture">
            + Écriture
          </button>
        </div>

        <div v-for="(w, i) in d.binding.writes" :key="i" class="space-y-2 rounded-lg bg-surface p-2.5">
          <div class="flex items-center gap-2">
            <select v-model="w.on" class="input flex-1 text-xs">
              <option v-for="cmd in COMMANDES" :key="cmd" :value="cmd">{{ cmd }}</option>
            </select>
            <button class="press text-[11px] text-crit" @click="d.binding.writes.splice(i, 1)">Retirer</button>
          </div>
          <input v-model="w.target" class="input font-mono text-xs" placeholder="topic ou chemin de commande" />
          <input v-model="w.payload" class="input font-mono text-xs" :placeholder="`charge utile : ${JETON}`" />
          <p class="hint">
            <code>{{ JETON }}</code> est remplacé par la valeur après transformation.
          </p>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="label">Transformations</span>
              <select
                class="rounded-md border border-line bg-ground px-2 py-1 text-[11px]"
                :value="''"
                @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) w.pipeline.push(neuve(v as TransformOp)); (e.target as HTMLSelectElement).value = ''; }"
              >
                <option value="">+ Ajouter</option>
                <option v-for="op in OPS" :key="op" :value="op">{{ TRANSFORM_LABELS[op] }}</option>
              </select>
            </div>
            <div
              v-for="(t, ti) in w.pipeline" :key="ti"
              class="flex flex-wrap items-center gap-1.5 rounded-md bg-ink/[0.04] px-2 py-1.5"
            >
              <select
                class="rounded border border-line bg-ground px-1.5 py-1 text-[11px]"
                :value="t.op"
                @change="(e) => changerOp(w.pipeline, ti, (e.target as HTMLSelectElement).value as TransformOp)"
              >
                <option v-for="op in OPS" :key="op" :value="op">{{ TRANSFORM_LABELS[op] }}</option>
              </select>
              <template v-if="t.op === 'scale'">
                <input v-model.number="t.factor" type="number" step="any" class="w-16 mini" aria-label="Facteur" />
                <input v-model.number="t.offset" type="number" step="any" class="w-16 mini" aria-label="Décalage" />
              </template>
              <input v-if="t.op === 'round'" v-model.number="t.decimals" type="number" min="0" max="4" class="w-14 mini" aria-label="Décimales" />
              <input v-if="t.op === 'invert'" v-model.number="t.span" type="number" class="w-16 mini" aria-label="Amplitude" />
              <textarea
                v-if="t.op === 'map'" rows="2" class="mini w-full font-mono" placeholder="true = ON&#10;false = OFF"
                :value="tableVersTexte(t.table)"
                @change="(e) => (t.table = texteVersTable((e.target as HTMLTextAreaElement).value))"
              />
              <button class="press ml-auto grid h-6 w-6 place-items-center rounded text-[11px] text-crit" @click="w.pipeline.splice(ti, 1)">×</button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!d.binding.reads.length && !d.binding.writes.length" class="flex items-start gap-2 text-xs text-warn">
        <Icon name="alerte" :size="14" class="mt-px" />
        Raccordé mais sans lecture ni écriture : il ne se passera rien.
      </p>
    </div>
  </div>
</template>

<style scoped>
.label { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.input {
  @apply w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink
         outline-none transition-colors placeholder:text-faint focus:border-glow;
}
.mini {
  @apply rounded border border-line bg-ground px-1.5 py-1 text-[11px] text-ink
         outline-none placeholder:text-faint focus:border-glow;
}
.hint { @apply text-xs leading-relaxed text-soft; }
.press { @apply transition-transform duration-150 active:scale-[0.97]; }
code { @apply rounded bg-ink/[0.06] px-1 font-mono text-[10px]; }
</style>
