<script setup lang="ts">
/**
 * Un volet, en tuile.
 *
 * Même metaphore que la lampe, retournee : le tablier descend depuis le haut,
 * exactement comme le vrai. On glisse vers le bas pour fermer, vers le haut
 * pour ouvrir : le geste est celui du volet lui-meme.
 */
import { computed } from 'vue';
import { findCap, type DeviceConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useTileDrag } from '@/composables/useTileDrag';

const props = defineProps<{ device: DeviceConfig }>();
const house = useHouse();

const state = computed(() => house.stateOf(props.device.id));
const injoignable = computed(() => !state.value || state.value.health !== 'online');
const pending = computed(() => state.value?.pending ?? false);
const cover = computed(() => findCap(state.value, 'cover'));
const position = computed(() => cover.value?.position ?? 0);
const bouge = computed(() => cover.value?.moving ?? null);

const drag = useTileDrag({
  valeur: () => position.value,
  actionnable: () => !injoignable.value && !pending.value,
  onGlisser: (v) => void house.send(props.device.id, { kind: 'cover', position: v }),
  // Un toucher bascule entre les deux extremes : c'est le geste courant.
  onToucher: () => void house.send(props.device.id, {
    kind: 'cover', position: position.value > 50 ? 0 : 100,
  }),
});

/** Un volet périmé ne montre pas de position : on ne sait plus où il est. */
const affiche = computed(() => (injoignable.value ? 0 : (drag.apercu.value ?? position.value)));
/** Part fermee : c'est elle qui donne la hauteur du tablier. */
const ferme = computed(() => 100 - affiche.value);

const SLATS = 8;
</script>

<template>
  <div
    class="tuile"
    :class="[
      injoignable ? 'tuile--muette' : 'tuile--active',
      drag.actif.value && 'scale-[1.02]',
    ]"
    role="slider"
    tabindex="0"
    :aria-label="injoignable ? `${device.label}, position inconnue` : `${device.label}, ${affiche} % ouvert`"
    :aria-valuenow="affiche" aria-valuemin="0" aria-valuemax="100"
    @pointerdown="drag.onPointerdown"
    @keydown.up.prevent="!injoignable && !pending && house.send(device.id, { kind: 'cover', position: Math.min(100, position + 10) })"
    @keydown.down.prevent="!injoignable && !pending && house.send(device.id, { kind: 'cover', position: Math.max(0, position - 10) })"
  >
    <!-- le jour, derriere -->
    <div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-jour/35 to-jour/10" />

    <!-- le tablier qui descend -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 flex flex-col overflow-hidden bg-raised transition-[height]"
      :class="[drag.actif.value ? 'duration-0' : 'duration-500 ease-swift', bouge && 'animate-pulse']"
      :style="{ height: `${ferme}%` }"
    >
      <span
        v-for="i in SLATS" :key="i"
        class="w-full shrink-0 border-b border-ink/[0.13]"
        :style="{ height: `${100 / SLATS}%` }"
      />
    </div>

    <div class="relative flex h-full flex-col justify-between p-3.5">
      <div class="flex items-start justify-between gap-2">
        <span class="grid h-9 w-9 place-items-center rounded-full bg-ink/[0.07] text-[15px] font-semibold text-soft">
          {{ bouge === 'down' ? '↓' : bouge === 'up' ? '↑' : '' }}
          <svg v-if="!bouge" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M4 4h16v16H4zM4 9h16M4 14h16" stroke-linecap="round" />
          </svg>
        </span>
        <span v-if="!injoignable" class="valeur">{{ affiche }}<span class="text-[10px]">%</span></span>
      </div>

      <div class="min-w-0">
        <p class="truncate text-[13px] font-semibold leading-tight text-ink">{{ device.label }}</p>
        <p class="etat">
          <template v-if="bouge">{{ bouge === 'down' ? 'fermeture…' : 'ouverture…' }}</template>
          <template v-else-if="injoignable">
            {{ state?.health === 'stale' ? 'valeur périmée' : 'hors ligne' }}
          </template>
          <template v-else-if="affiche === 0">fermé</template>
          <template v-else-if="affiche === 100">ouvert</template>
          <template v-else>entrouvert</template>
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
.tuile--active { @apply border-line bg-surface hover:border-jour/40; }
.tuile--muette { @apply border-dashed border-line opacity-70; }
.valeur { @apply font-mono text-lg font-semibold tabular-nums leading-none text-ink; }
.etat   { @apply mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-soft; }
</style>
