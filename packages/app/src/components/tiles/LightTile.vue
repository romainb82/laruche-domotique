<script setup lang="ts">
/**
 * Un éclairage, en tuile.
 *
 * La tuile EST le contrôle : on la touche pour allumer, on glisse dessus pour
 * régler l'intensité. Et elle se remplit de lumière à hauteur de ce qu'elle
 * éclaire : la surface allumée est l'information, avant même le pourcentage.
 *
 * Trois états visuels, toujours : allumé · en cours · injoignable.
 */
import { computed } from 'vue';
import { findCap, type DeviceConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useTileDrag } from '@/composables/useTileDrag';
import Icon from '../Icon.vue';

const props = defineProps<{ device: DeviceConfig }>();
const house = useHouse();

const state = computed(() => house.stateOf(props.device.id));
const pending = computed(() => state.value?.pending ?? false);
const injoignable = computed(() => !state.value || state.value.health !== 'online');
const allume = computed(() => findCap(state.value, 'switch')?.state ?? false);
const dim = computed(() => findCap(state.value, 'dim'));
const variable = computed(() => !!dim.value);

const niveau = computed(() => {
  if (!allume.value) return 0;
  return dim.value ? dim.value.level : 100;
});

const drag = useTileDrag({
  valeur: () => niveau.value,
  actionnable: () => !injoignable.value && variable.value,
  onGlisser: (v) => {
    if (v === 0) void house.send(props.device.id, { kind: 'switch', state: false });
    else void house.send(props.device.id, { kind: 'dim', level: Math.max(5, v) });
  },
  onToucher: () => void house.send(props.device.id, { kind: 'switch', state: !allume.value }),
});

/** Ce qu'on montre : l'aperçu pendant le geste, l'état réel sinon. */
const remplissage = computed(() => drag.apercu.value ?? niveau.value);

function basculer() {
  if (injoignable.value) return;
  void house.send(props.device.id, { kind: 'switch', state: !allume.value });
}
</script>

<template>
  <div
    class="tuile"
    :class="[
      injoignable ? 'tuile--muette' : allume ? 'tuile--vive' : 'tuile--eteinte',
      drag.actif.value && 'scale-[1.02]',
    ]"
    :role="variable ? 'slider' : 'button'"
    tabindex="0"
    :aria-label="device.label"
    :aria-pressed="variable ? undefined : allume"
    :aria-valuenow="variable ? niveau : undefined"
    :aria-valuemin="variable ? 0 : undefined"
    :aria-valuemax="variable ? 100 : undefined"
    :aria-valuetext="variable ? (allume ? `allumé à ${niveau} %` : 'éteint') : undefined"
    @pointerdown="variable ? drag.onPointerdown($event) : undefined"
    @click="variable ? undefined : basculer()"
    @keydown.enter.prevent="basculer"
    @keydown.space.prevent="basculer"
    @keydown.up.prevent="variable && house.send(device.id, { kind: 'dim', level: Math.min(100, niveau + 10) })"
    @keydown.down.prevent="variable && house.send(device.id, { kind: 'dim', level: Math.max(0, niveau - 10) })"
  >
    <!-- la lumière monte à hauteur de l'intensité -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-glow to-glow/70 transition-[height]"
      :class="drag.actif.value ? 'duration-0' : 'duration-500 ease-swift'"
      :style="{ height: `${remplissage}%` }"
    />

    <!-- Voile : le bord du remplissage passe à hauteur variable, le texte
         doit garder un fond stable quelle que soit l'intensité. -->
    <div
      v-if="remplissage > 0"
      class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-glow/45 to-transparent"
    />

    <div class="relative flex h-full flex-col justify-between p-3.5">
      <div class="flex items-start justify-between gap-2">
        <span
          class="grid h-9 w-9 place-items-center rounded-full transition-colors"
          :class="pending ? 'animate-pulse bg-ink/15' : allume ? 'bg-ink/15 text-ink' : 'bg-ink/[0.07] text-faint'"
        >
          <Icon name="ampoule" :size="18" />
        </span>
        <span v-if="variable && !injoignable" class="valeur">{{ remplissage }}<span class="text-[10px]">%</span></span>
      </div>

      <div class="min-w-0">
        <p class="truncate text-[13px] font-semibold leading-tight">{{ device.label }}</p>
        <p class="etat">
          <template v-if="pending">en cours…</template>
          <template v-else-if="injoignable">
            {{ state?.health === 'stale' ? 'valeur périmée' : 'hors ligne' }}
          </template>
          <template v-else>{{ allume ? 'allumé' : 'éteint' }}</template>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tuile {
  @apply relative aspect-square cursor-pointer select-none overflow-hidden
         rounded-[22px] border transition-all duration-300 ease-swift
         focus-visible:ring-2 focus-visible:ring-glow focus-visible:ring-offset-2;
  touch-action: none;
}
.tuile--vive   { @apply border-glow/50 bg-glow/[0.10] text-ink shadow-lit; }
.tuile--eteinte{ @apply border-line bg-surface text-soft hover:border-glow/30; }
.tuile--muette { @apply border-dashed border-line bg-surface/60 text-faint; }
.valeur { @apply font-mono text-lg font-semibold tabular-nums leading-none; }
/* L'opacite se cumulait avec une teinte deja trop pale : on retire l'un des
   deux. L'etat « hors ligne » est l'information la plus utile dans le noir. */
.etat   { @apply mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em]; }
</style>
