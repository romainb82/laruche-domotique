<script setup lang="ts">
/**
 * Les scenes.
 *
 * Un geste, plusieurs equipements. C'est ce qui separe piloter une maison de
 * l'habiter : on ne dit pas « eteins ces onze lampes et ferme ces treize
 * volets », on dit « bonne nuit ».
 *
 * Le retour est explicite : le bouton confirme, et signale les echecs plutot
 * que de les taire — une scene a moitie appliquee est pire qu'une scene ratee.
 */
import { ref } from 'vue';
import { useHouse } from '@/stores/house';
import { useAnnonce } from '@/composables/useAnnonce';
import Icon from './Icon.vue';

const house = useHouse();
const { annoncer } = useAnnonce();
const enCours = ref<string | null>(null);
const retour = ref<{ id: string; texte: string; ok: boolean } | null>(null);

async function jouer(id: string, label: string) {
  enCours.value = id;
  retour.value = null;
  try {
    const res = await fetch(`/api/scenes/${encodeURIComponent(id)}/apply`, { method: 'POST' });
    const body = await res.json();
    retour.value = body.echecs
      ? { id, texte: `${label} — ${body.echecs} équipement(s) n'ont pas répondu`, ok: false }
      : { id, texte: `${label} · ${body.total} équipements`, ok: true };
    annoncer(retour.value.texte);
  } catch {
    retour.value = { id, texte: `${label} — serveur injoignable`, ok: false };
    annoncer(retour.value.texte);
  } finally {
    enCours.value = null;
    setTimeout(() => { if (retour.value?.id === id) retour.value = null; }, 4000);
  }
}

const ICONES = ['soleil', 'porte', 'ampoule', 'lune', 'volet', 'maison', 'eclair', 'piscine'] as const;
const icone = (nom: string) =>
  (ICONES as readonly string[]).includes(nom) ? (nom as (typeof ICONES)[number]) : 'maison';
</script>

<template>
  <!--
    Plus de titre ici : la rangée vit desormais DANS une carte qui porte le
    sien. Deux en-têtes empilés se lisaient comme deux sections.
  -->
  <section v-if="house.scenes.length" class="space-y-2.5">
    <p v-if="retour" class="px-1 text-xs font-medium" :class="retour.ok ? 'text-ok' : 'text-crit'">
      {{ retour.texte }}
    </p>

    <!-- Défilement horizontal sur téléphone : les scènes gardent leur taille
         de cible au doigt au lieu de rétrécir. -->
    <div class="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
      <button
        v-for="s in house.scenes" :key="s.id"
        class="scene"
        :class="enCours === s.id && 'scene--active'"
        :disabled="enCours !== null"
        @click="jouer(s.id, s.label)"
      >
        <span class="pastille" :class="enCours === s.id && 'animate-pulse'">
          <Icon :name="icone(s.icon)" :size="21" />
        </span>
        <span class="nom">{{ s.label }}</span>
        <span class="compte">{{ s.actions.length }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.scene {
  @apply flex w-[86px] shrink-0 flex-col items-center gap-2 rounded-[22px] border border-line
         bg-surface px-2 py-3.5 transition-all duration-200
         hover:border-glow/45 active:scale-[0.96] disabled:opacity-60;
}
.scene--active { @apply border-glow/60 bg-glow/10; }
.pastille {
  @apply grid h-11 w-11 place-items-center rounded-full bg-ink/[0.06] text-soft
         transition-colors;
}
.scene:hover .pastille { @apply bg-glow/15 text-glow-deep; }
.nom     { @apply w-full truncate text-center text-[12px] font-medium leading-tight; }
.compte  { @apply font-mono text-[9px] uppercase tracking-[0.12em] text-faint; }
.label   { @apply font-mono text-[10px] uppercase tracking-[0.14em] text-faint; }
</style>
