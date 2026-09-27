<script setup lang="ts">
/**
 * Les scénarios.
 *
 * Ils étaient enfouis dans un onglet du paramétrage, à côté des identifiants
 * de broker et des emprises de plan. C'était la mauvaise place : une scène
 * n'est pas un réglage d'installation, c'est un geste quotidien. Le canvas de
 * refonte les sort au premier niveau, et il a raison.
 *
 * La disposition reprend la sienne : une grille de cartes à gauche, l'éditeur
 * du scénario choisi dans un panneau à droite. On voit donc ce qu'on modifie
 * ET le reste de la collection, au lieu de dérouler une liste de formulaires.
 *
 * Deux bandeaux encadrent la grille, et ils répondent aux deux seules
 * questions qu'on se pose devant une maison qui bouge toute seule : qu'est-ce
 * qui va partir, et qu'est-ce qui est parti.
 */
import { computed, onMounted, ref } from 'vue';
import { decrireTrigger, findCap, type SceneAction, type SceneConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useAnnonce } from '@/composables/useAnnonce';
import Icon from '@/components/Icon.vue';
import SceneEditor from '@/components/SceneEditor.vue';

const house = useHouse();
const { annoncer } = useAnnonce();

/** Brouillon local : on n'enregistre que sur action explicite. */
const draft = ref<SceneConfig[] | null>(null);
const choisi = ref<string | null>(null);
const saving = ref(false);
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
const lance = ref<Record<string, 'en-cours' | 'fait'>>({});

const prochain = ref<{ sceneId: string; label: string; at: string } | null>(null);
const passes = ref<
  { at: string; label: string; origin: string; total: number; echecs: number; refus: string | null }[]
>([]);

function reprendre() {
  // `structuredClone` refuse un proxy réactif de Vue : le passage par JSON est
  // laid mais c'est le seul qui marche sur un objet du store.
  draft.value = JSON.parse(JSON.stringify(house.config?.scenes ?? [])) as SceneConfig[];
  if (!choisi.value && draft.value.length) choisi.value = draft.value[0]!.id;
}

async function relire() {
  try {
    const [n, h] = await Promise.all([
      fetch('/api/scenes/next').then((r) => r.json()),
      fetch('/api/scenes/history?limit=6').then((r) => r.json()),
    ]);
    prochain.value = n.next ?? null;
    passes.value = h.runs ?? [];
  } catch {
    prochain.value = null;
    passes.value = [];
  }
}

onMounted(async () => {
  if (!house.config) await house.load();
  reprendre();
  await relire();
});

const tries = computed(() => [...(draft.value ?? [])].sort((a, b) => a.order - b.order));
const actifs = computed(() => (draft.value ?? []).filter((s) => s.enabled).length);
const scene = computed(() => (draft.value ?? []).find((s) => s.id === choisi.value) ?? null);
const modifie = computed(
  () => JSON.stringify(draft.value ?? []) !== JSON.stringify(house.config?.scenes ?? []),
);

// ------------------------------------------------------------------ résumé

/**
 * Ce que fait un scénario, en trois étiquettes.
 *
 * Résumé par NATURE d'action et non par pièce : « 6 allumés, 13 volets
 * fermés » se lit d'un coup d'œil, là où la liste des pièces touchées demande
 * de compter. Le détail reste dans l'éditeur, juste à côté.
 */
function resume(sc: SceneConfig): string[] {
  const n = { allume: 0, eteint: 0, varie: 0, ouvre: 0, ferme: 0, entrouvre: 0, consigne: 0 };
  for (const a of sc.actions) {
    const c = a.command;
    if (c.kind === 'switch') c.state ? n.allume++ : n.eteint++;
    else if (c.kind === 'dim') n.varie++;
    else if (c.kind === 'cover')
      c.position === 0 ? n.ferme++ : c.position === 100 ? n.ouvre++ : n.entrouvre++;
    else if (c.kind === 'climate') n.consigne++;
  }
  const out: string[] = [];
  if (n.allume) out.push(`${n.allume} allumé${n.allume > 1 ? 's' : ''}`);
  if (n.varie) out.push(`${n.varie} tamisé${n.varie > 1 ? 's' : ''}`);
  if (n.eteint) out.push(`${n.eteint} éteint${n.eteint > 1 ? 's' : ''}`);
  if (n.ouvre) out.push(`${n.ouvre} volet${n.ouvre > 1 ? 's' : ''} ouvert${n.ouvre > 1 ? 's' : ''}`);
  if (n.ferme) out.push(`${n.ferme} volet${n.ferme > 1 ? 's' : ''} fermé${n.ferme > 1 ? 's' : ''}`);
  if (n.entrouvre) out.push(`${n.entrouvre} entrouvert${n.entrouvre > 1 ? 's' : ''}`);
  if (n.consigne) out.push(`${n.consigne} consigne${n.consigne > 1 ? 's' : ''}`);
  return out.slice(0, 3);
}

/**
 * Le nom d'icône vient de la configuration, donc c'est du texte libre.
 *
 * Le composant, lui, n'en connaît qu'une liste fermée. Une icône inconnue
 * retombe sur la maison plutôt que de faire disparaître la vignette : un
 * scénario sans pastille se remarque moins qu'un scénario mal illustré.
 */
const ICONES = [
  'soleil', 'lune', 'porte', 'ampoule', 'volet', 'thermo', 'piscine',
  'eclair', 'maison', 'goutte', 'prise', 'alerte', 'reglages',
] as const;
type NomIcone = (typeof ICONES)[number];
const icone = (nom: string): NomIcone =>
  (ICONES as readonly string[]).includes(nom) ? (nom as NomIcone) : 'maison';

/** Les actions retardées font du scénario une séquence : ça se dit. */
function sequence(sc: SceneConfig): number {
  return sc.actions.filter((a: SceneAction) => (a.afterSeconds ?? 0) > 0).length;
}

/** Un scénario gardé dit sa garde, ET si elle est vraie en ce moment. */
function conditionLisible(sc: SceneConfig): string | null {
  const c = sc.condition;
  if (c?.kind !== 'device') return null;
  const d = house.devices.find((x) => x.id === c.deviceId);
  const nom = d?.label ?? 'équipement inconnu';
  const attendu = c.is === 'on' ? 'allumé' : 'éteint';
  if (!d) return `Si « ${nom} » est ${attendu}`;
  const remplie = (findCap(house.stateOf(d.id), 'switch')?.state === true) === (c.is === 'on');
  return `Si « ${nom} » est ${attendu} — ${remplie ? 'vrai' : 'faux'} en ce moment`;
}

// ------------------------------------------------------------------ gestes

async function lancer(sc: SceneConfig) {
  lance.value[sc.id] = 'en-cours';
  try {
    const r = await (
      await fetch(`/api/scenes/${encodeURIComponent(sc.id)}/apply`, { method: 'POST' })
    ).json();
    lance.value[sc.id] = 'fait';
    annoncer(
      r.ok
        ? `${sc.label} lancée — ${r.total} équipements.`
        : (r.refus ?? `${r.echecs} équipement(s) n'ont pas répondu.`),
    );
    setTimeout(() => { delete lance.value[sc.id]; }, 2500);
  } catch {
    delete lance.value[sc.id];
    annoncer('Serveur injoignable.');
  }
  await relire();
}

function ajouter() {
  if (!draft.value) return;
  draft.value.push({
    id: `scene-${Date.now().toString(36).slice(-5)}`,
    label: 'Nouveau scénario',
    icon: 'maison',
    order: draft.value.length,
    // Actif mais manuel : jouable tout de suite, incapable de partir seul tant
    // qu'il ne contient rien.
    enabled: true,
    trigger: { kind: 'manual' },
    condition: { kind: 'always' },
    actions: [],
  });
  choisi.value = draft.value[draft.value.length - 1]!.id;
}

function retirer(id: string) {
  if (!draft.value) return;
  draft.value = draft.value.filter((s) => s.id !== id);
  draft.value.forEach((s, i) => { s.order = i; });
  if (choisi.value === id) choisi.value = draft.value[0]?.id ?? null;
}

async function enregistrer() {
  if (!draft.value) return;
  saving.value = true;
  message.value = null;
  try {
    const res = await fetch('/api/scenes', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft.value),
    });
    const corps = await res.json();
    if (!res.ok)
      throw new Error(
        (corps.issues ?? []).map((i: { message: string }) => i.message).join(' ') || 'Refusé.',
      );
    await house.load();
    reprendre();
    await relire();
    message.value = { kind: 'ok', text: 'Enregistré.' };
    annoncer('Scénarios enregistrés.');
  } catch (e) {
    message.value = { kind: 'err', text: (e as Error).message };
  } finally {
    saving.value = false;
  }
}

function annuler() {
  reprendre();
  message.value = null;
}

const quand = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: house.config?.house.timezone ?? 'Europe/Paris',
    weekday: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
</script>

<template>
  <div v-if="draft" class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="label">Automatisation</p>
        <h1 class="mt-1.5 text-[28px] font-semibold leading-tight tracking-tight lg:text-4xl">
          Scénarios
        </h1>
        <p class="mt-2 text-sm text-soft">
          {{ draft.length }} scénario{{ draft.length > 1 ? 's' : '' }} ·
          {{ actifs }} actif{{ actifs > 1 ? 's' : '' }}
        </p>
      </div>
      <button class="btn" @click="ajouter">+ Nouveau scénario</button>
    </header>

    <!-- Ce qui va partir tout seul. -->
    <p
      v-if="prochain"
      class="flex items-center gap-2.5 rounded-2xl border border-glow/40 bg-glow/[0.07] px-4 py-3 text-sm"
    >
      <Icon name="soleil" :size="17" class="shrink-0 text-glow-deep" />
      <span>Prochain départ : <strong>{{ prochain.label }}</strong>, {{ quand(prochain.at) }}.</span>
    </p>
    <p v-else class="rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-soft">
      Aucun scénario ne part tout seul. Donne une heure à l'un d'eux dans « Quand ».
    </p>

    <div class="grid gap-5 xl:grid-cols-[1fr_minmax(380px,440px)] xl:items-start">
      <!-- La collection -->
      <section class="grid gap-3 sm:grid-cols-2">
        <article
          v-for="sc in tries" :key="sc.id"
          class="flex flex-col gap-3 rounded-[22px] border bg-surface p-4 transition-colors"
          :class="choisi === sc.id ? 'border-ink' : 'border-line'"
        >
          <div class="flex items-start gap-3">
            <span
              class="grid h-11 w-11 shrink-0 place-items-center rounded-[14px]"
              :class="sc.enabled ? 'bg-glow/15 text-glow-deep' : 'bg-ink/[0.06] text-faint'"
            >
              <Icon :name="icone(sc.icon)" :size="19" />
            </span>

            <button
              class="min-w-0 flex-1 text-left"
              :aria-label="`Modifier ${sc.label}`"
              @click="choisi = sc.id"
            >
              <span class="block truncate font-semibold">{{ sc.label }}</span>
              <span class="mt-0.5 block truncate text-xs text-soft">
                {{ sc.enabled ? decrireTrigger(sc.trigger) : 'Au repos' }}
              </span>
            </button>

            <input
              v-model="sc.enabled" type="checkbox"
              class="mt-1 h-6 w-6 shrink-0 accent-[rgb(var(--c-glow))]"
              :aria-label="`Activer ${sc.label}`"
            />
          </div>

          <ul v-if="resume(sc).length" class="flex flex-wrap gap-1.5">
            <li
              v-for="c in resume(sc)" :key="c"
              class="rounded-full border border-line bg-ground px-2.5 py-1 text-[11px] text-soft"
            >{{ c }}</li>
            <li
              v-if="sequence(sc)"
              class="rounded-full border border-line bg-ground px-2.5 py-1 text-[11px] text-soft"
            >{{ sequence(sc) }} différée{{ sequence(sc) > 1 ? 's' : '' }}</li>
          </ul>
          <p v-else class="text-xs text-faint">Aucune action — ce scénario ne ferait rien.</p>

          <p v-if="conditionLisible(sc)" class="text-[11px] text-soft">{{ conditionLisible(sc) }}</p>

          <div class="mt-auto flex items-center gap-2 border-t border-line pt-3">
            <button
              class="press flex-1 rounded-lg bg-ink/[0.06] py-2 text-xs font-semibold"
              :disabled="!sc.actions.length || lance[sc.id] === 'en-cours'"
              @click="lancer(sc)"
            >
              {{ lance[sc.id] === 'fait' ? 'Lancé' : lance[sc.id] ? 'En cours…' : 'Lancer' }}
            </button>
            <button
              class="press rounded-lg px-2.5 py-2 text-xs font-medium"
              :class="choisi === sc.id ? 'text-glow-deep' : 'text-soft'"
              @click="choisi = sc.id"
            >Modifier</button>
          </div>
        </article>
      </section>

      <!-- L'éditeur du scénario choisi -->
      <aside v-if="scene" class="space-y-3">
        <p class="label px-1">Scénario en cours de modification</p>
        <SceneEditor :scene="scene" @remove="retirer(scene.id)" />
      </aside>
    </div>

    <!-- Ce qui est parti, et pourquoi certains ne sont pas partis. -->
    <details v-if="passes.length" class="rounded-2xl border border-line bg-surface px-4 py-3">
      <summary class="cursor-pointer text-sm text-soft">Derniers départs</summary>
      <ul class="mt-2 space-y-1.5 text-xs">
        <li v-for="(r, k) in passes" :key="k" class="flex flex-wrap gap-x-2">
          <span class="font-mono text-faint">{{ quand(r.at) }}</span>
          <strong>{{ r.label }}</strong>
          <span class="text-soft">{{ r.origin === 'schedule' ? 'automatique' : 'à la demande' }}</span>
          <span v-if="r.refus" class="text-warn-deep">— {{ r.refus }}</span>
          <span v-else-if="r.echecs" class="text-crit">— {{ r.echecs }} échec(s) sur {{ r.total }}</span>
          <span v-else class="text-soft">— {{ r.total }} action(s)</span>
        </li>
      </ul>
    </details>

    <!-- La barre d'enregistrement, qui n'apparaît que s'il y a de quoi. -->
    <div
      v-if="modifie || message"
      class="sticky bottom-20 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-card backdrop-blur-xl lg:bottom-4"
    >
      <p v-if="message" class="text-sm" :class="message.kind === 'ok' ? 'text-ok' : 'text-crit'">
        {{ message.text }}
      </p>
      <p v-else class="text-sm text-soft">Modifications non enregistrées</p>
      <button class="press ml-auto rounded-lg px-3 py-2 text-sm text-soft" @click="annuler">Annuler</button>
      <button class="btn" :disabled="saving" @click="enregistrer">
        {{ saving ? 'Enregistrement…' : 'Enregistrer' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.label { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.press { @apply transition-transform duration-150 active:scale-[0.97] disabled:opacity-40; }
.btn {
  @apply shrink-0 rounded-xl bg-glow-deep px-4 py-2.5 text-sm font-semibold text-surface
         transition-transform duration-150 active:scale-[0.97] disabled:opacity-50;
}
</style>
