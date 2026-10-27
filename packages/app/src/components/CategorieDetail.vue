<script setup lang="ts">
/**
 * Le panneau d'une famille, à la place du détail de pièce.
 *
 * Même emplacement que `ZoneDetail`, même largeur, mêmes tuiles : seul le
 * critère de regroupement change. On range par pièce et non par type, parce
 * qu'une fois la famille choisie le type est déjà connu : ce qu'on cherche
 * ensuite, c'est « lequel ».
 *
 * Les tuiles viennent de `DeviceControl`, comme partout ailleurs. Une
 * deuxième implémentation aurait divergé au premier changement d'état.
 */
import { computed } from 'vue';
import { findCap } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { CATEGORIES, appartient, type CategorieId } from '@/composables/categories';
import DeviceControl from '@/components/DeviceControl.vue';
import Icon from './Icon.vue';

const props = defineProps<{ categorie: CategorieId }>();
const emit = defineEmits<{ (e: 'fermer'): void }>();

const house = useHouse();

const famille = computed(() => CATEGORIES.find((c) => c.id === props.categorie)!);

const equipements = computed(() => house.devices.filter((d) => appartient(d, props.categorie)));

/**
 * Rangés par pièce, dans l'ordre du plan. Les pièces hors plan ferment la
 * marche : ce sont le garage, l'extérieur et le bassin, qu'on consulte moins.
 */
const groupes = computed(() => {
  const ordre = [...house.planZones, ...house.offPlanZones];
  return ordre
    .map((z) => ({
      titre: z.label,
      items: equipements.value.filter((d) => d.zoneId === z.id),
    }))
    .filter((g) => g.items.length);
});

/** Combien sont allumés, ouverts, ou simplement présents. */
const compte = computed(() => {
  const n = equipements.value.length;
  if (props.categorie === 'lights') {
    const allumes = equipements.value.filter(
      (d) => findCap(house.stateOf(d.id), 'switch')?.state === true,
    ).length;
    return `${allumes} allumé${allumes > 1 ? 's' : ''} sur ${n}`;
  }
  if (props.categorie === 'covers') {
    const ouverts = equipements.value.filter((d) => {
      const c = findCap(house.stateOf(d.id), 'cover');
      return c && c.position > 5;
    }).length;
    return `${ouverts} ouvert${ouverts > 1 ? 's' : ''} sur ${n}`;
  }
  return `${n} équipement${n > 1 ? 's' : ''}`;
});

/**
 * Le libellé bascule selon ce qui est allumé : s'il reste une lampe allumée,
 * le geste utile est d'éteindre. Proposer les deux boutons en permanence
 * obligerait à lire avant de cliquer.
 */
const toutesEteintes = computed(() =>
  equipements.value.every((d) => findCap(house.stateOf(d.id), 'switch')?.state !== true),
);

const ids = computed(() => equipements.value.map((d) => d.id));

const basculerLumieres = () =>
  house.sendBulk(ids.value, { kind: 'switch', state: toutesEteintes.value });

const bougerVolets = (position: number) => house.sendBulk(ids.value, { kind: 'cover', position });
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3 px-1">
      <p class="label">Famille</p>
      <button
        type="button"
        class="press rounded-lg px-2 py-1.5 text-xs font-medium text-soft hover:text-ink"
        @click="emit('fermer')"
      >
        Fermer
      </button>
    </div>

    <section class="space-y-4 rounded-[22px] border border-line bg-surface p-4">
      <div class="flex items-center gap-3.5">
        <span
          class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px]"
          :class="
            famille.teinte === 'jour' ? 'bg-jour/15 text-jour-deep' : 'bg-glow/15 text-glow-deep'
          "
        >
          <Icon :name="famille.icone" :size="23" />
        </span>
        <div class="flex min-w-0 flex-col gap-0.5">
          <h2 class="truncate text-lg font-semibold leading-tight">{{ famille.nom }}</h2>
          <span class="text-[13px] text-soft">{{ compte }}</span>
        </div>
      </div>

      <div v-if="categorie === 'lights' || categorie === 'covers'" class="flex flex-wrap gap-2">
        <button
          v-if="categorie === 'lights'"
          type="button"
          class="press rounded-lg bg-ink/[0.06] px-3.5 py-2 text-sm font-medium hover:bg-ink/10"
          @click="basculerLumieres"
        >
          {{ toutesEteintes ? 'Tout allumer' : 'Tout éteindre' }}
        </button>
        <template v-if="categorie === 'covers'">
          <button
            type="button"
            class="press rounded-lg bg-ink/[0.06] px-3.5 py-2 text-sm font-medium hover:bg-ink/10"
            @click="bougerVolets(0)"
          >
            Tout fermer
          </button>
          <button
            type="button"
            class="press rounded-lg bg-ink/[0.06] px-3.5 py-2 text-sm font-medium hover:bg-ink/10"
            @click="bougerVolets(100)"
          >
            Tout ouvrir
          </button>
        </template>
      </div>
    </section>

    <!--
      Deux colonnes et non trois comme dans la maquette : le panneau fait
      420 px, et nos tuiles portent un libellé complet plus un état. À trois,
      le texte se coupait.
    -->
    <section v-for="g in groupes" :key="g.titre" class="space-y-2.5">
      <h3 class="label px-1">{{ g.titre }}</h3>
      <div class="grid gap-2.5 sm:grid-cols-2">
        <DeviceControl v-for="d in g.items" :key="d.id" :device="d" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.label {
  @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint;
}
</style>
