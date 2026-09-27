<script setup lang="ts">
/**
 * Une piece, en tuile large.
 *
 * Elle rayonne quand la piece est allumee, et porte ses trois informations
 * utiles : ce qui est allume, ou en sont les volets, quelle temperature il fait.
 */
import { computed } from 'vue';
import { findCap, type ZoneConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import Icon from './Icon.vue';

const props = defineProps<{ zone: ZoneConfig }>();
const house = useHouse();

const resume = computed(() => {
  const devices = house.devicesOf(props.zone.id);
  const lights = devices.filter((d) => d.type === 'light' || d.type === 'dimmer');
  const lit = lights.filter((d) => findCap(house.stateOf(d.id), 'switch')?.state === true);

  const covers = devices.filter((d) => d.type === 'cover');
  const positions = covers
    .map((d) => findCap(house.stateOf(d.id), 'cover'))
    .filter((c): c is NonNullable<typeof c> => !!c);

  const tempDevice = devices.find((d) => d.type === 'sensor' && d.metric === 'temperature');
  const tempState = tempDevice ? house.stateOf(tempDevice.id) : undefined;
  const tempCap = findCap(tempState, 'sensor');

  // L'eclat de la tuile suit l'intensite moyenne, pas le simple compte.
  const eclat = lights.length
    ? lit.reduce((s, d) => s + (findCap(house.stateOf(d.id), 'dim')?.level ?? 100) / 100, 0) / lights.length
    : 0;

  return {
    lit: lit.length,
    lights: lights.length,
    eclat: Math.min(1, eclat),
    covers: covers.length,
    ouverture: positions.length
      ? Math.round(positions.reduce((s, c) => s + c.position, 0) / positions.length)
      : null,
    bouge: positions.some((c) => c.moving),
    temperature: tempCap && tempState?.health === 'online' ? tempCap.value : null,
    total: devices.length,
  };
});
</script>

<template>
  <RouterLink
    :to="`/zone/${zone.id}`"
    class="relative block overflow-hidden rounded-[22px] border p-4 transition-all duration-300 ease-swift active:scale-[0.98]"
    :class="resume.lit ? 'border-glow/40 bg-glow/[0.07] shadow-lit' : 'border-line bg-surface hover:border-glow/25'"
  >
    <div
      v-if="resume.lit"
      class="pointer-events-none absolute inset-0 bg-gradient-to-tr from-glow/25 to-transparent transition-opacity duration-500"
      :style="{ opacity: 0.35 + resume.eclat * 0.5 }"
    />

    <div class="relative flex items-center gap-3">
      <span
        class="grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors"
        :class="resume.lit ? 'bg-glow text-surface' : 'bg-ink/[0.07] text-faint'"
      >
        <Icon name="ampoule" :size="18" />
      </span>

      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold leading-tight">{{ zone.label }}</p>
        <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
          <template v-if="resume.lit">{{ resume.lit }} / {{ resume.lights }} allumés</template>
          <template v-else-if="resume.total">{{ resume.total }} équipements</template>
          <template v-else>vide</template>
        </p>
      </div>

      <span
        v-if="resume.temperature !== null"
        class="shrink-0 font-mono text-xl font-semibold tabular-nums"
      >{{ resume.temperature.toFixed(1) }}<span class="text-xs text-faint">°</span></span>
    </div>

    <div v-if="resume.covers" class="relative mt-3 flex items-center gap-2">
      <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/10">
        <span
          class="block h-full rounded-full bg-jour transition-all duration-500 ease-swift"
          :style="{ width: `${resume.ouverture ?? 0}%` }"
        />
      </span>
      <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em]"
            :class="resume.bouge ? 'text-jour' : 'text-faint'">
        {{ resume.bouge ? '···' : `${resume.ouverture} %` }}
      </span>
    </div>
  </RouterLink>
</template>
