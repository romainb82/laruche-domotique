<script setup lang="ts">
/** Aiguille vers la tuile qui correspond a la nature de l'equipement. */
import type { DeviceConfig } from '@domo/shared';
import LightTile from './tiles/LightTile.vue';
import CoverTile from './tiles/CoverTile.vue';
import ClimateTile from './tiles/ClimateTile.vue';
import SensorTile from './tiles/SensorTile.vue';

defineProps<{ device: DeviceConfig }>();
</script>

<template>
  <LightTile v-if="device.type === 'light' || device.type === 'dimmer'" :device="device" />
  <CoverTile v-else-if="device.type === 'cover'" :device="device" />
  <ClimateTile v-else-if="device.type === 'thermostat'" :device="device" />
  <SensorTile v-else :device="device" />
</template>
