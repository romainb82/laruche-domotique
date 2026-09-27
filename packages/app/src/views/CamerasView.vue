<script setup lang="ts">
/**
 * Les caméras.
 *
 * Un instantané rafraîchi, pas un flux vidéo. Le direct demanderait de
 * transcoder du RTSP en permanence ; une image toutes les deux secondes suffit
 * à voir qui sonne, et tient sur un Raspberry Pi.
 *
 * L'image vient du SERVEUR, jamais de la caméra : le navigateur n'a ni les
 * identifiants ni l'adresse, et l'affichage marche aussi bien depuis
 * l'extérieur par le tunnel que sur le réseau local.
 *
 * Chaque image porte son horodatage. Une caméra qui a cessé de répondre
 * afficherait sinon sa dernière image indéfiniment, ce qui est exactement le
 * mensonge qu'une caméra de sécurité ne doit pas faire.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '@/components/Icon.vue';

interface Camera {
  id: string;
  label: string;
  zoneId: string;
  order: number;
  enabled: boolean;
  refreshSeconds: number;
  protegee: boolean;
}

const cameras = ref<Camera[]>([]);
const chargement = ref(true);
/** Jeton de rafraîchissement par caméra : il force le navigateur à redemander. */
const jetons = ref<Record<string, number>>({});
/** Dernière image reçue, et dernier échec, par caméra. */
const vues = ref<Record<string, { at: number; erreur: string | null }>>({});
const agrandie = ref<string | null>(null);

const minuteries: number[] = [];

async function charger() {
  try {
    const r = await (await fetch('/api/cameras')).json();
    cameras.value = r.cameras ?? [];
    for (const c of cameras.value) {
      jetons.value[c.id] = Date.now();
      vues.value[c.id] = { at: 0, erreur: null };
      if (!c.enabled) continue;
      const periode = Math.max(1, c.refreshSeconds) * 1000;
      minuteries.push(window.setInterval(() => { jetons.value[c.id] = Date.now(); }, periode));
    }
  } finally {
    chargement.value = false;
  }
}

onMounted(charger);
onBeforeUnmount(() => minuteries.forEach(clearInterval));

const url = (c: Camera) =>
  `/api/cameras/${encodeURIComponent(c.id)}/snapshot?t=${jetons.value[c.id] ?? 0}`;

function recue(c: Camera) {
  vues.value[c.id] = { at: Date.now(), erreur: null };
}

/**
 * L'échec ne dit pas pourquoi : une balise `img` ne donne jamais le corps de
 * la réponse. On redemande donc l'image en `fetch` pour lire le message que le
 * serveur a pris soin d'écrire.
 */
async function ratee(c: Camera) {
  let raison = 'Image indisponible.';
  try {
    const r = await fetch(url(c));
    if (!r.ok) raison = (await r.json())?.error ?? raison;
  } catch {
    /* le serveur lui-même est injoignable : le bandeau global le dit déjà */
  }
  vues.value[c.id] = { at: vues.value[c.id]?.at ?? 0, erreur: raison };
}

const actives = computed(() => cameras.value.filter((c) => c.enabled));
const eteintes = computed(() => cameras.value.filter((c) => !c.enabled));

const heure = (ms: number) =>
  new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(ms));

function basculer(id: string) {
  agrandie.value = agrandie.value === id ? null : id;
}
</script>

<template>
  <div class="space-y-7">
    <header>
      <p class="label">Sécurité</p>
      <h1 class="mt-1.5 text-[28px] font-semibold leading-tight tracking-tight lg:text-4xl">
        Caméras
      </h1>
      <p class="mt-2 text-sm text-soft">
        {{ actives.length }} active{{ actives.length > 1 ? 's' : '' }}
        <span v-if="eteintes.length">· {{ eteintes.length }} au repos</span>
      </p>
    </header>

    <p
      v-if="actives.length"
      class="flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn/[0.08] px-4 py-3 text-sm text-warn-deep"
    >
      <Icon name="alerte" :size="17" class="mt-px shrink-0" />
      <span>
        Le serveur n'a aucune authentification : toute machine du réseau local
        qui connaît son adresse peut demander ces images. Pour des lampes c'est
        sans conséquence, pour des caméras d'intérieur, non.
      </span>
    </p>

    <p
      v-if="!chargement && !cameras.length"
      class="rounded-2xl border border-dashed border-line px-6 py-12 text-center text-sm text-soft"
    >
      Aucune caméra déclarée.
      <RouterLink to="/parametrage" class="font-medium text-glow-deep underline">En ajouter</RouterLink>
    </p>

    <section
      v-else-if="actives.length"
      class="grid gap-3"
      :class="agrandie ? '' : 'sm:grid-cols-2 xl:grid-cols-3'"
    >
      <figure
        v-for="c in actives"
        :key="c.id"
        class="overflow-hidden rounded-[22px] border border-line bg-surface"
        :class="agrandie && agrandie !== c.id ? 'hidden' : ''"
      >
        <button
          class="relative block w-full bg-ink/90 transition-opacity hover:opacity-95"
          :aria-label="agrandie === c.id ? `Réduire ${c.label}` : `Agrandir ${c.label}`"
          @click="basculer(c.id)"
        >
          <img
            :src="url(c)"
            :alt="`Vue de la caméra ${c.label}`"
            class="block w-full"
            :class="agrandie === c.id ? 'max-h-[70dvh] object-contain' : 'aspect-video object-cover'"
            @load="recue(c)"
            @error="ratee(c)"
          />

          <!--
            En bas à droite : les caméras incrustent presque toujours LEUR
            horodatage en haut, et deux horloges superposées ne se lisent ni
            l'une ni l'autre.
          -->
          <span
            v-if="!vues[c.id]?.erreur"
            class="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-ink/80 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-surface backdrop-blur-sm"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-crit"></span>
            {{ vues[c.id]?.at ? heure(vues[c.id]!.at) : '…' }}
          </span>
        </button>

        <figcaption class="flex items-center justify-between gap-2 px-4 py-3">
          <span class="truncate text-sm font-medium">{{ c.label }}</span>
          <span v-if="vues[c.id]?.erreur" class="shrink-0 text-xs text-crit">
            {{ vues[c.id]?.erreur }}
          </span>
          <span v-else class="shrink-0 font-mono text-[10px] uppercase tracking-wider text-faint">
            toutes les {{ c.refreshSeconds }} s
          </span>
        </figcaption>
      </figure>
    </section>

    <p
      v-else-if="!chargement"
      class="rounded-2xl border border-dashed border-line px-6 py-12 text-center text-sm text-soft"
    >
      Toutes les caméras sont au repos.
    </p>

    <section v-if="eteintes.length" class="space-y-2">
      <h2 class="label px-1">Au repos</h2>
      <ul class="flex flex-wrap gap-2">
        <li
          v-for="c in eteintes"
          :key="c.id"
          class="rounded-full border border-line bg-surface px-3.5 py-2 text-xs text-soft"
        >{{ c.label }}</li>
      </ul>
    </section>

    <p class="rounded-2xl border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-soft">
      Ce sont des images fixes rafraîchies, pas un flux vidéo. Le direct
      demanderait de transcoder le flux de chaque caméra en permanence. L'image
      passe par le serveur : les identifiants des caméras ne quittent jamais la
      maison, et l'affichage marche aussi depuis l'extérieur.
    </p>
  </div>
</template>

<style scoped>
.label {
  @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint;
}
</style>
