<script setup lang="ts">
/**
 * Le plan de la maison : l'écran principal.
 *
 * Il montre deux choses d'un seul coup d'œil, sans un mot à lire :
 *   · une pièce allumée rayonne en ambre ;
 *   · chaque ouvrant porte son volet, dessiné à sa position réelle.
 *
 * Toute la géométrie vient de la configuration, jamais du code : redécouper une
 * pièce ou déplacer une fenêtre se fait depuis l'écran Paramétrage.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { findCap } from '@domo/shared';
import { useHouse } from '@/stores/house';

const props = defineProps<{ selected?: string }>();
const emit = defineEmits<{ select: [zoneId: string] }>();
const house = useHouse();

interface Room {
  id: string;
  label: string;
  rects: { x: number; y: number; w: number; h: number }[];
  lit: number;
  brightness: number; // 0–1, pilote l'intensité de la lueur
  temperature: number | null;
  centre: { x: number; y: number };
  taille: number;
  place: boolean;
}

const rooms = computed<Room[]>(() =>
  house.planZones.map((z) => {
    const devices = house.devicesOf(z.id);
    const lights = devices.filter((d) => d.type === 'light' || d.type === 'dimmer');

    let lit = 0;
    let sum = 0;
    for (const d of lights) {
      const st = house.stateOf(d.id);
      if (findCap(st, 'switch')?.state !== true) continue;
      lit++;
      sum += (findCap(st, 'dim')?.level ?? 100) / 100;
    }

    const tempDevice = devices.find((d) => d.type === 'sensor' && d.metric === 'temperature');
    const tempState = tempDevice ? house.stateOf(tempDevice.id) : undefined;
    const tempCap = findCap(tempState, 'sensor');

    const rects = z.plan ?? [];
    // Le plus grand rectangle porte l'étiquette : sur une pièce en L,
    // c'est le seul placement qui ne tombe jamais dans le couloir.
    const main = rects.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b), rects[0]!);

    return {
      id: z.id,
      label: z.label,
      rects,
      lit,
      brightness: lights.length ? Math.min(1, sum / Math.max(1, lights.length)) : 0,
      temperature: tempCap && tempState?.health === 'online' ? tempCap.value : null,
      centre: { x: main.x + main.w / 2, y: main.y + main.h / 2 },
      // Une piece etroite ne peut pas porter le meme corps de texte qu'un salon.
      taille: main.w < 55 ? 8 : main.w < 80 ? 9.5 : 11,
      // Sous une certaine hauteur, le nom seul tient : la temperature saute.
      place: main.h >= 45,
    };
  }),
);

/** Les volets, dessinés sur le mur qu'ils occupent. */
const shutters = computed(() =>
  house.devices
    .filter((d) => d.type === 'cover' && d.opening)
    .map((d) => {
      const cap = findCap(house.stateOf(d.id), 'cover');
      return {
        id: d.id,
        o: d.opening!,
        position: cap?.position ?? 0,
        moving: cap?.moving ?? null,
      };
    }),
);

/** L'enveloppe de la maison, avec son décrochement à l'est. */
/**
 * L'enveloppe, relevée sur le plan du diagnostic d'avril 2026.
 *
 * Deux décrochements, et non un seul : la maison s'élargit à l'est au niveau
 * de la chambre 4, et la buanderie descend plus bas que le reste au sud-ouest.
 * L'ancien tracé ignorait le second et plaçait le premier trop haut.
 */
const OUTLINE = 'M30 30 H590 V173 H615 V287 H132 V309 H30 Z';

/**
 * Le plan est cadré sur les murs, pas sur le repère de saisie : sans ça, le
 * dessin flotte au milieu d'une marge vide et paraît deux fois trop petit.
 */
const CADRE = { x: 22, y: 22, w: 601, h: 295 };

/**
 * La maison est un rectangle deux fois plus large que haut. Dans un téléphone
 * tenu en portrait, elle ne peut donc être que minuscule : sur 358 px de large,
 * une chambre fait 12 px de haut et son nom devient illisible.
 *
 * On bascule le plan d'un quart de tour sur mobile. Le sens est choisi pour
 * amener la cuisine et le salon en haut : ce sont les pièces qu'on touche le
 * plus, elles doivent être sous le pouce sans faire défiler. La maison occupe
 * alors la hauteur de l'écran au lieu de sa largeur, et double de taille.
 *
 * Les étiquettes sont contre-pivotées d'autant pour rester horizontales : un
 * nom de pièce couché sur le flanc serait un remède pire que le mal.
 */
const requete = window.matchMedia('(max-width: 640px)');
const portrait = ref(requete.matches);
const suivre = (e: MediaQueryListEvent) => { portrait.value = e.matches; };
requete.addEventListener('change', suivre);
onBeforeUnmount(() => requete.removeEventListener('change', suivre));

/** Quart de tour : (x, y) → (318 − y, x − 22). Le mur nord part à droite. */
const PIVOT = `matrix(0,1,-1,0,${CADRE.y + CADRE.h},${-CADRE.x})`;

const boite = computed(() =>
  portrait.value
    ? `0 0 ${CADRE.h} ${CADRE.w}`
    : `${CADRE.x} ${CADRE.y} ${CADRE.w} ${CADRE.h}`,
);

/** Annule la rotation du groupe, autour du point d'ancrage du texte. */
const redresser = (x: number, y: number) =>
  portrait.value ? `rotate(-90 ${x} ${y})` : undefined;

const isSelected = (id: string) => props.selected === id;
</script>

<template>
  <svg
    :viewBox="boite"
    class="mx-auto w-full select-none"
    :class="portrait ? 'max-h-[76dvh]' : 'max-h-[400px]'"
    role="group"
    aria-label="Plan de la maison"
  >
    <defs>
      <!-- La lueur d'une pièce allumée -->
      <radialGradient id="lueur" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgb(var(--c-glow))" stop-opacity="0.42" />
        <stop offset="100%" stop-color="rgb(var(--c-glow))" stop-opacity="0.10" />
      </radialGradient>
      <filter id="halo" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
    </defs>

    <g :transform="portrait ? PIVOT : undefined">
    <!-- halo diffus sous les pièces allumées -->
    <g filter="url(#halo)" opacity="0.85">
      <template v-for="r in rooms.filter((x) => x.lit)" :key="`h-${r.id}`">
        <rect
          v-for="(rect, i) in r.rects" :key="i"
          :x="rect.x" :y="rect.y" :width="rect.w" :height="rect.h"
          fill="rgb(var(--c-glow))"
          :opacity="0.10 + r.brightness * 0.22"
        />
      </template>
    </g>

    <!-- murs porteurs -->
    <path :d="OUTLINE" fill="none" class="stroke-ink/60" stroke-width="3" stroke-linejoin="round" />

    <!-- pièces -->
    <g v-for="r in rooms" :key="r.id">
      <g
        class="cursor-pointer"
        role="button"
        tabindex="0"
        :aria-label="`${r.label}${r.lit ? `, ${r.lit} allumé` : ''}${r.temperature !== null ? `, ${r.temperature.toFixed(1)} degrés` : ''}`"
        @click="emit('select', r.id)"
        @keydown.enter="emit('select', r.id)"
        @keydown.space.prevent="emit('select', r.id)"
      >
        <!-- Cible de frappe : certaines pièces sont plus fines que le minimum
             de 24 px une fois le plan mis à l'échelle. Ce rectangle invisible
             garantit la prise au doigt sans changer le dessin. -->
        <rect
          v-for="(rect, i) in r.rects"
          :key="`t-${i}`"
          :x="rect.x + rect.w / 2 - Math.max(rect.w, 28) / 2"
          :y="rect.y + rect.h / 2 - Math.max(rect.h, 28) / 2"
          :width="Math.max(rect.w, 28)" :height="Math.max(rect.h, 28)"
          fill="transparent"
        />

        <rect
          v-for="(rect, i) in r.rects"
          :key="i"
          :x="rect.x" :y="rect.y" :width="rect.w" :height="rect.h"
          rx="3"
          :fill="r.lit ? 'url(#lueur)' : 'rgb(var(--c-ink) / 0.045)'"
          :fill-opacity="r.lit ? 0.55 + r.brightness * 0.45 : 1"
          :class="[
            'transition-all duration-500 ease-swift',
            // La sélection se lit en encre, jamais en ambre : l'ambre dit
            // « allumé », et une pièce sélectionnée peut être éteinte.
            isSelected(r.id) ? 'stroke-ink' : r.lit ? 'stroke-glow' : 'stroke-ink/25 hover:fill-ink/10',
          ]"
          :stroke-width="isSelected(r.id) ? 2.5 : r.lit ? 1.6 : 1"
        />

        <text
          :x="r.centre.x" :y="r.place && r.temperature !== null ? r.centre.y - 2 : r.centre.y + 3"
          :transform="redresser(r.centre.x, r.centre.y)"
          text-anchor="middle"
          :font-size="r.taille"
          :class="['pointer-events-none font-semibold', r.lit ? 'fill-glow-deep' : 'fill-ink']"
        >{{ r.label }}</text>

        <text
          v-if="r.temperature !== null && r.place"
          :x="r.centre.x" :y="r.centre.y + 11"
          :transform="redresser(r.centre.x, r.centre.y)"
          text-anchor="middle"
          :font-size="r.taille - 2"
          class="pointer-events-none fill-soft tabular-nums"
        >{{ r.temperature.toFixed(1) }}°</text>
      </g>
    </g>

    <!-- volets : le trait s'efface à mesure que le volet s'ouvre -->
    <g v-for="s in shutters" :key="s.id">
      <!-- l'ouvrant, toujours visible -->
      <line
        :x1="s.o.x1" :y1="s.o.y1" :x2="s.o.x2" :y2="s.o.y2"
        class="stroke-ground" stroke-width="6" stroke-linecap="butt"
      />
      <line
        :x1="s.o.x1" :y1="s.o.y1" :x2="s.o.x2" :y2="s.o.y2"
        class="stroke-jour/25" stroke-width="5" stroke-linecap="butt"
      />
      <!-- le tablier : plein = ferme, absent = ouvert -->
      <line
        :x1="s.o.x1"
        :y1="s.o.y1"
        :x2="s.o.x1 + (s.o.x2 - s.o.x1) * (1 - s.position / 100)"
        :y2="s.o.y1 + (s.o.y2 - s.o.y1) * (1 - s.position / 100)"
        :class="['stroke-jour transition-all duration-300', s.moving && 'animate-pulse']"
        stroke-width="5"
        stroke-linecap="butt"
      />
    </g>
    </g>
  </svg>
</template>

<style scoped>
/*
 * Le focus clavier sur une pièce.
 *
 * Deux choses l'empêchent de fonctionner tout seul. D'abord `ring-*` de
 * Tailwind est un box-shadow, qui ne se peint pas de façon fiable sur un <g>
 * SVG, et la règle globale pose `outline-none` par-dessus. Ensuite Chromium
 * dessine son propre anneau bleu sur un <g> porteur de tabindex, y compris à
 * la souris : il jure avec la palette et se confond avec le bleu des volets.
 *
 * On coupe donc l'anneau du navigateur dans les deux cas, et on dessine le
 * nôtre sur le rectangle de la pièce.
 *
 * Sur une forme SVG, Chromium n'honore que le style et l'épaisseur du
 * contour : `outline-color` et `outline-offset` sont ignorés, mesuré. La
 * couleur vient donc de `currentColor`, soit l'encre héritée du corps de page.
 *
 * Cela tombe juste : l'ambre dit « allumé » partout ailleurs dans
 * l'application, et une pièce peut très bien avoir le focus en étant éteinte.
 * L'encre ne prête pas à confusion, et se voit sur les deux fonds.
 */
g[role='button'],
g[role='button']:focus,
g[role='button']:focus-visible {
  outline: none;
}
g[role='button']:focus-visible rect:not([fill='transparent']) {
  outline-style: solid;
  outline-width: 3px;
}
</style>
