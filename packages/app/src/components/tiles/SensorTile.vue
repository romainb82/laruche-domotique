<script setup lang="ts">
/**
 * Une mesure, en tuile.
 *
 * Elle se remplit aussi : a hauteur de la valeur dans sa plage normale. Une
 * humidite de 80 % ou un pH hors cible se voient donc avant d'etre lus.
 * Une valeur perimee n'est jamais affichee : elle devient un tiret.
 */
import { computed } from 'vue';
import { METRIC_LABELS, findCap, type DeviceConfig, type Metric } from '@domo/shared';
import { useHouse } from '@/stores/house';
import Icon from '../Icon.vue';

const props = defineProps<{ device: DeviceConfig }>();
const house = useHouse();

const state = computed(() => house.stateOf(props.device.id));
const injoignable = computed(() => !state.value || state.value.health !== 'online');
const sensor = computed(() => findCap(state.value, 'sensor'));

const ICONS: Partial<Record<Metric, 'thermo' | 'goutte' | 'soleil' | 'piscine' | 'prise' | 'porte'>> = {
  temperature: 'thermo', humidity: 'goutte', lux: 'soleil',
  ph: 'piscine', orp: 'piscine', power: 'prise', contact: 'porte',
};

/** Plages « normales », qui donnent son sens au remplissage. */
const PLAGES: Partial<Record<Metric, [number, number]>> = {
  temperature: [10, 30], humidity: [20, 80], lux: [0, 15000],
  ph: [6.5, 8], orp: [500, 850], power: [0, 4000], battery: [0, 100],
};

const remplissage = computed(() => {
  const s = sensor.value;
  const plage = s ? PLAGES[s.metric] : undefined;
  if (!s || !plage || injoignable.value) return 0;
  return Math.round(Math.min(100, Math.max(0, ((s.value - plage[0]) / (plage[1] - plage[0])) * 100)));
});

const texte = computed(() => {
  const s = sensor.value;
  if (!s || injoignable.value) return { valeur: '-', unite: '' };
  if (s.metric === 'contact') return { valeur: s.value > 0 ? 'Ouvert' : 'Fermé', unite: '' };
  return { valeur: String(s.value), unite: s.unit };
});

/** Le pH hors plage est la seule mesure qui doit sauter aux yeux. */
/**
 * Le nom de la grandeur n'est affiche que s'il apporte quelque chose : un
 * capteur nomme « Temperature » n'a pas besoin qu'on lui repete « TEMPERATURE ».
 */
const sousTitre = computed(() => {
  const s = sensor.value;
  if (injoignable.value) return state.value?.health === 'stale' ? 'périmé' : 'hors ligne';
  if (!s) return '';
  const nom = METRIC_LABELS[s.metric];
  return nom.toLowerCase() === props.device.label.toLowerCase() ? '' : nom;
});

const alerte = computed(() => {
  const s = sensor.value;
  const cible = house.config?.pool.phTarget;
  if (!s || injoignable.value || s.metric !== 'ph' || !cible) return false;
  return s.value < cible[0] || s.value > cible[1];
});
</script>

<template>
  <div class="tuile" :class="[injoignable ? 'tuile--muette' : alerte ? 'tuile--alerte' : 'tuile--calme']">
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 transition-[height] duration-700 ease-swift"
      :class="alerte ? 'bg-crit/25' : 'bg-jour/20'"
      :style="{ height: `${remplissage}%` }"
    />

    <div class="relative flex h-full flex-col justify-between p-3.5">
      <div class="flex items-start justify-between gap-2">
        <span class="grid h-9 w-9 place-items-center rounded-full bg-ink/[0.07]"
              :class="alerte ? 'text-crit' : 'text-faint'">
          <Icon v-if="sensor && ICONS[sensor.metric]" :name="ICONS[sensor.metric]!" :size="17" />
        </span>
        <Icon v-if="alerte" name="alerte" :size="16" class="text-crit" />
      </div>

      <div class="min-w-0">
        <p class="font-mono text-xl font-semibold tabular-nums leading-none"
           :class="alerte ? 'text-crit' : injoignable ? 'text-faint' : 'text-ink'">
          {{ texte.valeur }}<span v-if="texte.unite" class="ml-0.5 text-[11px] font-normal text-soft">{{ texte.unite }}</span>
        </p>
        <p class="mt-1.5 truncate text-[12px] font-medium leading-tight text-soft">{{ device.label }}</p>
        <p v-if="sousTitre" class="etat">{{ sousTitre }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tuile { @apply relative aspect-square overflow-hidden rounded-[22px] border transition-colors duration-300; }
.tuile--calme  { @apply border-line bg-surface; }
.tuile--alerte { @apply border-crit/45 bg-crit/[0.06]; }
.tuile--muette { @apply border-dashed border-line opacity-70; }
.etat { @apply mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-faint; }
</style>
