<script setup lang="ts">
/**
 * L'arc de réglage.
 *
 * Un cadran ouvert vers le bas : le vide en bas donne l'échelle (le minimum à
 * gauche, le maximum à droite) sans qu'on ait à lire une graduation. On le
 * tourne au doigt, ou on ajuste au demi-degré avec les deux boutons.
 *
 * Le geste circulaire est plus précis qu'un curseur linéaire sur la même
 * surface : 270° de course contre la largeur d'une carte.
 */
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{
  /** Valeur affichée. */
  valeur: number;
  min: number;
  max: number;
  /** Ce qu'on écrit au centre : déjà formaté. */
  texte: string;
  unite?: string;
  /** Légende sous le chiffre. */
  legende?: string;
  pas?: number;
  actif?: boolean;
  desactive?: boolean;
  /** Teinte de l'arc : chaud pour la lumière, froid pour les ouvrants. */
  teinte?: 'glow' | 'jour';
}>(), { pas: 0.5, actif: true, desactive: false, teinte: 'glow', unite: '', legende: '' });

const emit = defineEmits<{ 'update:valeur': [v: number] }>();

const DEPART = 135;
const COURSE = 270;
const R = 78;
const C = 100;

const fraction = computed(() => {
  const f = (props.valeur - props.min) / (props.max - props.min);
  return Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));
});

function polaire(deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
}

function arc(debut: number, fin: number): string {
  const s = polaire(debut);
  const e = polaire(fin);
  const grand = fin - debut > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${grand} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const piste = computed(() => arc(DEPART, DEPART + COURSE));
const remplie = computed(() => arc(DEPART, DEPART + COURSE * Math.max(0.001, fraction.value)));
const poignee = computed(() => polaire(DEPART + COURSE * fraction.value));

const glisse = ref(false);
const svg = ref<SVGSVGElement | null>(null);

/** Position du doigt → valeur. Le vide du bas est une zone morte, pas un saut. */
function versValeur(e: PointerEvent): number | null {
  const el = svg.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);

  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  // On ramène l'angle dans la course 135°→405°.
  if (deg < DEPART - 45) deg += 360;
  if (deg < DEPART) deg = DEPART;
  if (deg > DEPART + COURSE) deg = DEPART + COURSE;

  const f = (deg - DEPART) / COURSE;
  const brut = props.min + f * (props.max - props.min);
  return Math.round(brut / props.pas) * props.pas;
}

function debut(e: PointerEvent) {
  if (props.desactive || !props.actif) return;
  glisse.value = true;
  (e.currentTarget as Element).setPointerCapture(e.pointerId);
  const v = versValeur(e);
  if (v !== null) emit('update:valeur', v);
}

function bouge(e: PointerEvent) {
  if (!glisse.value) return;
  const v = versValeur(e);
  if (v !== null) emit('update:valeur', v);
}

function fin(e: PointerEvent) {
  glisse.value = false;
  (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
}

function pousser(delta: number) {
  if (props.desactive) return;
  const v = Math.min(props.max, Math.max(props.min, props.valeur + delta));
  if (v !== props.valeur) emit('update:valeur', v);
}

const couleur = computed(() => (props.teinte === 'jour' ? 'stroke-jour' : 'stroke-glow'));
</script>

<template>
  <div class="flex items-center justify-center gap-3 sm:gap-5">
    <button class="pas" :disabled="desactive" aria-label="Diminuer" @click="pousser(-props.pas)">−</button>

    <div class="relative w-[190px] shrink-0 sm:w-[220px]">
      <svg
        ref="svg" viewBox="0 0 200 200" class="w-full"
        :class="[desactive ? 'opacity-50' : 'cursor-pointer', glisse && 'select-none']"
        role="slider" tabindex="0"
        :aria-valuenow="valeur" :aria-valuemin="min" :aria-valuemax="max"
        :aria-label="legende || 'Réglage'"
        style="touch-action: none"
        @pointerdown="debut" @pointermove="bouge" @pointerup="fin" @pointercancel="fin"
        @keydown.up.prevent="pousser(props.pas)" @keydown.down.prevent="pousser(-props.pas)"
      >
        <!-- la piste : elle dit où sont le minimum et le maximum -->
        <path :d="piste" fill="none" class="stroke-ink/[0.08]" stroke-width="14" stroke-linecap="round" />

        <!-- la course parcourue -->
        <path
          :d="remplie" fill="none"
          :class="[couleur, glisse ? 'transition-none' : 'transition-all duration-500 ease-swift']"
          stroke-width="14" stroke-linecap="round"
        />

        <!-- la poignée, pour montrer que ça se tourne -->
        <circle
          :cx="poignee.x" :cy="poignee.y" :r="glisse ? 11 : 9"
          class="fill-surface transition-all duration-200"
          :class="teinte === 'jour' ? 'stroke-jour' : 'stroke-glow'"
          stroke-width="3.5"
        />
      </svg>

      <!-- le chiffre, au centre du cadran -->
      <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-3">
        <p class="font-mono text-[40px] font-semibold leading-none tabular-nums sm:text-[46px]">
          {{ texte }}<span v-if="unite" class="text-lg text-soft">{{ unite }}</span>
        </p>
        <p v-if="legende" class="label mt-2">{{ legende }}</p>
      </div>

      <!-- les bornes, dans le vide du bas -->
      <div class="pointer-events-none absolute inset-x-3 bottom-2 flex justify-between font-mono text-[10px] tabular-nums text-faint">
        <span>{{ min }}</span><span>{{ max }}</span>
      </div>
    </div>

    <button class="pas" :disabled="desactive" aria-label="Augmenter" @click="pousser(props.pas)">+</button>
  </div>
</template>

<style scoped>
.pas {
  @apply grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ink/[0.06] text-2xl
         font-light leading-none text-ink transition-all duration-150
         hover:bg-ink/[0.12] active:scale-95 disabled:opacity-30;
}
.label { @apply font-mono text-[10px] uppercase tracking-[0.14em] text-faint; }
</style>
