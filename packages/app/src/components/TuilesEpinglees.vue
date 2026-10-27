<script setup lang="ts">
/**
 * Les épinglés, en tête de l'accueil.
 *
 * Une maison a quinze pièces et soixante-douze équipements, mais on en touche
 * cinq au quotidien. Cette rangée les met à portée sans avoir à traverser le
 * plan.
 *
 * ÉCART ASSUMÉ AVEC LA MAQUETTE : elle propose d'épingler par appui long sur
 * une tuile. Impossible ici : `useTileDrag` occupe déjà le geste de pression
 * sur les tuiles d'éclairage, de volet et de climat, pour permettre de glisser
 * et régler l'intensité ou la position. Son propre commentaire explique qu'il
 * existe justement POUR éviter l'appui long, « un geste que personne ne
 * découvre tout seul ». On passe donc par un bouton « Modifier » : plus
 * visible, et qui ne casse pas le variateur.
 *
 * Les tuiles sont celles de `DeviceControl`, comme partout ailleurs.
 */
import { computed, ref } from 'vue';
import { useHouse } from '@/stores/house';
import { useEpingles } from '@/composables/epingles';
import DeviceControl from '@/components/DeviceControl.vue';

const house = useHouse();
const { epingles, fixer, resoudreDefauts } = useEpingles();

const edition = ref(false);

/**
 * La sélection qui s'applique : celle qu'on a enregistrée, ou les défauts tant
 * que personne n'a rien choisi. Une liste vide ENREGISTRÉE reste vide : c'est
 * un choix, pas une absence de choix.
 */
const effectifs = computed(() => epingles.value ?? resoudreDefauts(house.devices));

const estEpingle = (id: string) => effectifs.value.includes(id);

const basculer = (id: string) =>
  fixer(estEpingle(id) ? effectifs.value.filter((x) => x !== id) : [...effectifs.value, id]);

/**
 * Repartir de la sélection conseillée.
 *
 * Sans ce bouton, qui a une fois tout décoché n'avait plus aucun moyen de
 * retrouver les six tuiles de départ : son choix vide est enregistré, et un
 * choix enregistré prime toujours sur les défauts.
 */
const remettreDefauts = () => fixer(resoudreDefauts(house.devices));

/**
 * On conserve l'ordre d'épinglage plutôt que l'ordre de la maison : c'est
 * l'ordre que la personne a choisi, même sans s'en rendre compte.
 * Un identifiant devenu introuvable : équipement supprimé depuis : disparaît
 * silencieusement au lieu de laisser un trou.
 */
const choisis = computed(() =>
  effectifs.value
    .map((id) => house.devices.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d)),
);

/** Le catalogue du mode édition, rangé par pièce comme le reste. */
const parPiece = computed(() => {
  const ordre = [...house.planZones, ...house.offPlanZones];
  return ordre
    .map((z) => ({
      id: z.id,
      titre: z.label,
      items: house.devices.filter((d) => d.zoneId === z.id),
    }))
    .filter((g) => g.items.length);
});
</script>

<template>
  <section class="space-y-2.5">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
      <h2 class="label">Épinglés</h2>
      <div class="flex items-center gap-3">
        <span v-if="!edition && choisis.length" class="text-xs text-soft">
          {{ choisis.length }} sur l'accueil
        </span>
        <button
          type="button"
          class="press rounded-lg px-2 py-1.5 text-xs font-medium text-glow-deep"
          @click="edition = !edition"
        >
          {{ edition ? 'Terminé' : 'Modifier' }}
        </button>
      </div>
    </div>

    <!-- Le choix. Des cases à cocher, parce que c'est bien ce que c'est. -->
    <div v-if="edition" class="space-y-4 rounded-[22px] border border-line bg-surface p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-[52ch] text-sm text-soft">
          Cochez ce que vous voulez garder sous la main. Le choix reste sur cet
          appareil&nbsp;: il ne suit ni les autres téléphones, ni les autres navigateurs.
        </p>
        <button
          type="button"
          class="press min-h-[44px] shrink-0 rounded-lg bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium hover:bg-ink/10"
          @click="remettreDefauts"
        >
          Sélection conseillée
        </button>
      </div>
      <fieldset v-for="g in parPiece" :key="g.id" class="space-y-2">
        <legend class="label mb-1">{{ g.titre }}</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="d in g.items"
            :key="d.id"
            class="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm"
            :class="estEpingle(d.id) ? 'border-glow bg-glow/[0.08]' : 'border-line bg-ground'"
          >
            <input
              type="checkbox"
              class="h-4 w-4 accent-glow-deep"
              :checked="estEpingle(d.id)"
              @change="basculer(d.id)"
            />
            <span>{{ d.label }}</span>
          </label>
        </div>
      </fieldset>
    </div>

    <p
      v-else-if="!choisis.length"
      class="rounded-[22px] border border-dashed border-line px-5 py-7 text-center text-sm text-soft"
    >
      <!--
        Pas de bouton en ligne ici : à 20 px de haut il tombait sous le
        minimum de WCAG 2.5.8, et « Modifier », juste au-dessus, fait déjà la
        même chose en pleine taille. Deux chemins vers le même geste, dont un
        trop petit, ce n'était pas un service à rendre.
      -->
      Rien d'épinglé. Choisissez avec «&nbsp;Modifier&nbsp;» les équipements que
      vous utilisez tous les jours&nbsp;: ils apparaîtront ici, avant le plan.
    </p>

    <div v-else class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
      <DeviceControl v-for="d in choisis" :key="d.id" :device="d" />
    </div>
  </section>
</template>

<style scoped>
.label {
  @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint;
}
</style>
