<script setup lang="ts">
/**
 * Le chauffage, en tuile large.
 *
 * Le remplissage situe la consigne entre le minimum et le maximum autorises :
 * on voit d'un coup d'oeil si on chauffe raisonnablement, sans lire le chiffre.
 * Glisser regle la consigne ; les boutons restent la pour le reglage fin.
 */
import { computed } from 'vue';
import { findCap, type DeviceConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useTileDrag } from '@/composables/useTileDrag';
import Icon from '../Icon.vue';

const props = defineProps<{ device: DeviceConfig }>();
const house = useHouse();

const state = computed(() => house.stateOf(props.device.id));
const injoignable = computed(() => !state.value || state.value.health !== 'online');
const climate = computed(() => findCap(state.value, 'climate'));

const bornes = computed(() => ({
  min: house.config?.heating.minSetpoint ?? 14,
  max: house.config?.heating.maxSetpoint ?? 24,
}));

/** Position de la consigne dans la plage, en pourcentage. */
const pourcent = computed(() => {
  const c = climate.value;
  if (!c) return 0;
  const { min, max } = bornes.value;
  return Math.round(((c.setpoint - min) / (max - min)) * 100);
});

const versConsigne = (pct: number) => {
  const { min, max } = bornes.value;
  return Math.round((min + (pct / 100) * (max - min)) * 2) / 2;
};

const drag = useTileDrag({
  valeur: () => pourcent.value,
  actionnable: () => !injoignable.value,
  onGlisser: (v) => void house.send(props.device.id, { kind: 'climate', setpoint: versConsigne(v) }),
  onToucher: () => {},
});

const affichePct = computed(() => drag.apercu.value ?? pourcent.value);
const afficheConsigne = computed(() =>
  drag.apercu.value !== null ? versConsigne(drag.apercu.value) : (climate.value?.setpoint ?? 20),
);

function pousser(delta: number) {
  const c = climate.value;
  if (!c || injoignable.value) return;
  const { min, max } = bornes.value;
  const next = Math.min(max, Math.max(min, c.setpoint + delta));
  if (next !== c.setpoint) void house.send(props.device.id, { kind: 'climate', setpoint: next });
}
</script>

<template>
  <div
    class="tuile col-span-2"
    :class="[
      injoignable ? 'tuile--muette' : climate?.demand ? 'tuile--chauffe' : 'tuile--repos',
      drag.actif.value && 'scale-[1.01]',
    ]"
  >
    <div
      class="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-glow/70 to-glow transition-[width]"
      :class="drag.actif.value ? 'duration-0' : 'duration-500 ease-swift'"
      :style="{ width: `${affichePct}%` }"
    />

    <div class="relative flex h-full items-center gap-4 p-4">
      <div
        class="flex-1 cursor-pointer select-none"
        role="slider" tabindex="0"
        :aria-label="`Consigne de ${device.label}`"
        :aria-valuenow="afficheConsigne" :aria-valuemin="bornes.min" :aria-valuemax="bornes.max"
        style="touch-action: none"
        @pointerdown="drag.onPointerdown"
        @keydown.up.prevent="pousser(0.5)"
        @keydown.down.prevent="pousser(-0.5)"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors"
            :class="climate?.demand ? 'bg-ink/15 text-ink' : 'bg-ink/[0.07] text-faint'"
          >
            <Icon name="thermo" :size="18" />
          </span>
          <div class="min-w-0">
            <p class="truncate text-[13px] font-semibold leading-tight text-ink">{{ device.label }}</p>
            <p class="etat">
              <template v-if="injoignable">hors ligne</template>
              <template v-else-if="climate?.demand">chauffe · {{ climate.ambient.toFixed(1) }}° mesurés</template>
              <template v-else-if="climate">au repos · {{ climate.ambient.toFixed(1) }}° mesurés</template>
            </p>
          </div>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <button class="pas" :disabled="injoignable" aria-label="Baisser la consigne" @click="pousser(-0.5)">−</button>
        <span class="w-[62px] text-center font-mono text-2xl font-semibold tabular-nums leading-none text-ink">
          {{ injoignable ? '—' : afficheConsigne.toFixed(1) }}<span class="text-sm">°</span>
        </span>
        <button class="pas" :disabled="injoignable" aria-label="Monter la consigne" @click="pousser(0.5)">+</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tuile {
  @apply relative overflow-hidden rounded-[22px] border transition-all duration-300 ease-swift;
  min-height: 96px;
}
.tuile--chauffe { @apply border-glow/40 bg-glow/[0.08] shadow-lit; }
.tuile--repos   { @apply border-line bg-surface; }
.tuile--muette  { @apply border-dashed border-line opacity-70; }
.etat { @apply mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-soft; }
.pas {
  @apply grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink/[0.07] text-xl
         font-light leading-none text-ink transition-colors hover:bg-ink/[0.13]
         disabled:opacity-40;
}
</style>
