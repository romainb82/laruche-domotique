<script setup lang="ts">
/**
 * Le rail des quatre familles, en tête de l'accueil.
 *
 * Il répond à une question que le plan ne sait pas poser : « où en sont les
 * volets », toutes pièces confondues. Chaque bouton bascule : un deuxième clic
 * referme le panneau, pour qu'on retrouve la pièce sélectionnée.
 *
 * Le résumé sous le nom vient du matériel, jamais d'un compteur local : si
 * trois lampes sont muettes, elles ne sont comptées ni allumées ni éteintes.
 */
import { computed } from 'vue';
import { useHouse } from '@/stores/house';
import { CATEGORIES, appartient, resumer, type CategorieId } from '@/composables/categories';
import Icon from './Icon.vue';

const props = defineProps<{ choisie: CategorieId | null }>();
const emit = defineEmits<{ (e: 'choisir', id: CategorieId | null): void }>();

const house = useHouse();

const familles = computed(() =>
  CATEGORIES.map((c) => {
    const equipements = house.devices.filter((d) => appartient(d, c.id));
    return {
      ...c,
      ...resumer(c.id, equipements, (id) => house.stateOf(id) as never),
      nombre: equipements.length,
      ouverte: props.choisie === c.id,
    };
  }).filter((c) => c.nombre > 0),
);

function basculer(id: CategorieId) {
  emit('choisir', props.choisie === id ? null : id);
}
</script>

<template>
  <div
    v-if="familles.length"
    role="group"
    aria-label="Familles d'équipements"
    class="grid grid-cols-2 gap-2.5 sm:grid-cols-4"
  >
    <button
      v-for="f in familles"
      :key="f.id"
      type="button"
      :aria-pressed="f.ouverte"
      class="press flex min-h-[56px] items-center gap-2.5 rounded-2xl border py-2 pl-2.5 pr-3.5 text-left"
      :class="
        f.ouverte
          ? 'border-ink bg-ink text-surface'
          : 'border-line bg-surface text-ink hover:border-ink/25'
      "
      @click="basculer(f.id)"
    >
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
        :class="
          f.ouverte
            ? 'bg-surface/15 text-surface'
            : f.actif
              ? f.teinte === 'jour'
                ? 'bg-jour/15 text-jour-deep'
                : 'bg-glow/15 text-glow-deep'
              : 'bg-ink/[0.06] text-faint'
        "
      >
        <Icon :name="f.icone" :size="19" />
      </span>
      <span class="flex min-w-0 flex-col gap-px">
        <span class="text-sm font-semibold">{{ f.nom }}</span>
        <span
          class="truncate text-xs"
          :class="
            f.ouverte
              ? 'text-surface/75'
              : f.actif
                ? f.teinte === 'jour'
                  ? 'text-jour-deep'
                  : 'text-glow-deep'
                : 'text-soft'
          "
        >{{ f.label }}</span>
      </span>
    </button>
  </div>
</template>
