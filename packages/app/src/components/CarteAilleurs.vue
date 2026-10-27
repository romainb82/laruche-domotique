<script setup lang="ts">
/**
 * Une pièce hors plan : le Général, la Piscine, l'Extérieur.
 *
 * Elles n'ont pas de place sur le dessin de la maison, mais elles portent ce
 * qu'on consulte le plus souvent sans y aller : la température dehors, le pH
 * du bassin, la consommation. D'où une carte plus bavarde que `RoomCard` :
 * elle donne les mesures directement, au lieu d'obliger à ouvrir la pièce.
 *
 * Trois étages, dans cet ordre de lecture :
 *   1. le nom et ce qui est allumé, avec le geste qui va avec ;
 *   2. les mesures, en chiffres alignés ;
 *   3. ce qui ne va pas, et seulement si quelque chose ne va pas.
 */
import { computed } from 'vue';
import { findCap, METRIC_UNITS, type ZoneConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import Icon from './Icon.vue';

const props = defineProps<{ zone: ZoneConfig }>();

const house = useHouse();

const equipements = computed(() => house.devicesOf(props.zone.id));

const ICONES: Record<string, 'eclair' | 'piscine' | 'soleil' | 'maison'> = {
  general: 'eclair',
  pool: 'piscine',
  outdoor: 'soleil',
};
const icone = computed(() => ICONES[props.zone.kind ?? ''] ?? 'maison');

// ------------------------------------------------------------- les lampes

const lampes = computed(() =>
  equipements.value.filter((d) => d.type === 'light' || d.type === 'dimmer'),
);

const allumees = computed(
  () => lampes.value.filter((d) => findCap(house.stateOf(d.id), 'switch')?.state === true).length,
);

const volets = computed(() => equipements.value.filter((d) => d.type === 'cover'));

/** Ce qu'on lit sous le nom : l'état en un coup d'œil, sans jargon. */
const etat = computed(() => {
  if (lampes.value.length) {
    return allumees.value
      ? `${allumees.value} / ${lampes.value.length} allumé${allumees.value > 1 ? 's' : ''}`
      : 'tout éteint';
  }
  const n = equipements.value.length;
  return `${n} équipement${n > 1 ? 's' : ''}`;
});

const basculerLampes = () =>
  house.sendBulk(
    lampes.value.map((d) => d.id),
    { kind: 'switch', state: allumees.value === 0 },
  );

const bougerVolets = (position: number) =>
  house.sendBulk(
    volets.value.map((d) => d.id),
    { kind: 'cover', position },
  );

// ------------------------------------------------------------ les mesures

const cible = computed(() => house.config?.pool.phTarget ?? null);

const nombre = (v: number, decimales: number) => v.toFixed(decimales).replace('.', ',');

/**
 * Les mesures de la pièce, mises en forme.
 *
 * `contact` en est exclu : « Ouvert » n'est pas une mesure, c'est une alerte,
 * et il est traité plus bas. Un capteur injoignable montre un tiret plutôt
 * qu'une valeur périmée : règle d'or du projet.
 */
const mesures = computed(() =>
  equipements.value
    .filter((d) => d.type === 'sensor' && d.metric && d.metric !== 'contact')
    .map((d) => {
      const st = house.stateOf(d.id);
      const cap = findCap(st, 'sensor');
      const muet = !cap || st?.health !== 'online';
      const unite = d.metric ? METRIC_UNITS[d.metric] : '';

      if (muet) return { cle: d.id, texte: '-', alerte: true, titre: d.label, ph: false };

      // Chaque grandeur a sa précision : un pH au centième, une température
      // au dixième, une puissance à l'unité. Trois décimales partout ne
      // diraient rien de plus.
      let texte: string;
      let alerte = false;
      if (d.metric === 'ph') {
        texte = `pH ${nombre(cap.value, 2)}`;
        alerte = Boolean(cible.value && (cap.value < cible.value[0] || cap.value > cible.value[1]));
      } else if (d.metric === 'temperature') {
        texte = `${nombre(cap.value, 1)} ${unite}`;
      } else {
        texte = `${Math.round(cap.value).toLocaleString('fr-FR')} ${unite}`;
      }
      return { cle: d.id, texte, alerte, titre: d.label, ph: d.metric === 'ph' };
    }),
);

/** Ce qui ne va pas, en une phrase. Vide la plupart du temps, et tant mieux. */
const soucis = computed(() => {
  const out: string[] = [];
  for (const d of equipements.value) {
    const st = house.stateOf(d.id);
    if (st && st.health !== 'online') {
      out.push(`${d.label} muet`);
      continue;
    }
    if (d.metric === 'contact' && findCap(st, 'sensor')?.value) out.push(`${d.label} ouvert`);
  }
  if (mesures.value.some((m) => m.ph && m.alerte) && cible.value)
    out.push(`pH hors de ${nombre(cible.value[0], 1)}–${nombre(cible.value[1], 1)}`);
  return out;
});
</script>

<template>
  <div
    class="flex flex-col gap-3 rounded-[22px] border p-4 transition-colors"
    :class="allumees ? 'border-glow/40 bg-glow/[0.07]' : 'border-line bg-surface'"
  >
    <div class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        :class="allumees ? 'bg-glow/15 text-glow-deep' : 'bg-ink/[0.06] text-faint'"
      >
        <Icon :name="icone" :size="20" />
      </span>

      <RouterLink :to="`/zone/${zone.id}`" class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm font-semibold text-ink">{{ zone.label }}</span>
        <span class="truncate text-xs text-soft">{{ etat }}</span>
      </RouterLink>

      <div v-if="lampes.length || volets.length" class="flex shrink-0 gap-1.5">
        <button
          v-if="lampes.length"
          type="button"
          class="press min-h-[36px] rounded-lg bg-ink/[0.06] px-3 text-xs font-medium hover:bg-ink/10"
          @click="basculerLampes"
        >
          {{ allumees ? 'Éteindre' : 'Allumer' }}
        </button>
        <template v-if="volets.length">
          <button
            type="button"
            :aria-label="`Fermer les volets · ${zone.label}`"
            class="press flex min-h-[36px] w-9 items-center justify-center rounded-lg bg-ink/[0.06] hover:bg-ink/10"
            @click="bougerVolets(0)"
          >
            <Icon name="volet" :size="16" />
          </button>
          <button
            type="button"
            :aria-label="`Ouvrir les volets · ${zone.label}`"
            class="press flex min-h-[36px] w-9 items-center justify-center rounded-lg bg-ink/[0.06] hover:bg-ink/10"
            @click="bougerVolets(100)"
          >
            <Icon name="soleil" :size="16" />
          </button>
        </template>
      </div>
    </div>

    <dl v-if="mesures.length" class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <div v-for="m in mesures" :key="m.cle" class="flex items-baseline gap-1.5">
        <dt class="sr-only">{{ m.titre }}</dt>
        <dd
          class="m-0 font-mono text-xs tabular-nums"
          :class="m.alerte ? 'text-crit' : 'text-soft'"
        >{{ m.texte }}</dd>
      </div>
    </dl>

    <p
      v-if="soucis.length"
      class="flex items-start gap-2 rounded-xl bg-crit/[0.08] px-3 py-2 text-xs text-crit"
    >
      <Icon name="alerte" :size="14" class="mt-px shrink-0" />
      <span>{{ soucis.join(' · ') }}</span>
    </p>
  </div>
</template>
