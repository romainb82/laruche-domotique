<script setup lang="ts">
/**
 * L'accueil.
 *
 * Refondu sur le canvas : le plan occupe la colonne principale, la pièce
 * choisie s'ouvre à côté, et tout le reste se range autour en cartes courtes.
 *
 * Deux décisions méritent d'être dites.
 *
 * 1. **La grille de pièces disparaît sur grand écran.** Le plan la remplace :
 *    il dit la même chose, en montrant en plus où se trouvent les pièces les
 *    unes par rapport aux autres. Garder les deux, c'était deux inventaires
 *    du même bien. En dessous de 1280 px le panneau latéral n'a pas la place,
 *    donc la grille revient : c'est le seul moment où elle sert encore.
 * 2. **« Tout éteindre » monte en tête.** C'est le geste le plus fréquent
 *    après les scénarios, et il était noyé dans une tuile de comptage.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { findCap } from '@domo/shared';
import { useHouse } from '@/stores/house';
import { useAnnonce } from '@/composables/useAnnonce';
import HousePlan from '@/components/HousePlan.vue';
import RoomCard from '@/components/RoomCard.vue';
import ZoneDetail from '@/components/ZoneDetail.vue';
import SceneRow from '@/components/SceneRow.vue';
import Icon from '@/components/Icon.vue';
import CategorieRail from '@/components/CategorieRail.vue';
import CategorieDetail from '@/components/CategorieDetail.vue';
import TuilesEpinglees from '@/components/TuilesEpinglees.vue';
import JournalActivite from '@/components/JournalActivite.vue';
import CarteAilleurs from '@/components/CarteAilleurs.vue';
import VignettesCameras from '@/components/VignettesCameras.vue';
import type { CategorieId } from '@/composables/categories';

const house = useHouse();
const router = useRouter();
const { annoncer } = useAnnonce();

// ------------------------------------------------------------- l'état bref

const bilan = computed(() => {
  const lights = house.devices.filter((d) => d.type === 'light' || d.type === 'dimmer');
  const covers = house.devices.filter((d) => d.type === 'cover');
  const allumes = lights.filter((d) => findCap(house.stateOf(d.id), 'switch')?.state === true);
  const positions = covers.map((d) => findCap(house.stateOf(d.id), 'cover'));

  const mesure = (id: string) => {
    const st = house.stateOf(id);
    const cap = findCap(st, 'sensor');
    return cap && st?.health === 'online' ? cap.value : null;
  };

  // La température de la maison, en un chiffre : moyenne des pièces CHAUFFÉES.
  // Inclure le garage ou l'extérieur ne dirait plus rien de ce qu'on ressent.
  const chauffees = new Set(house.zones.filter((z) => z.heated).map((z) => z.id));
  const interieures = house.devices
    .filter((d) => d.metric === 'temperature' && chauffees.has(d.zoneId))
    .map((d) => mesure(d.id))
    .filter((v): v is number => v !== null);

  const ext = house.devices.find((d) => d.zoneId === 'z21' && d.metric === 'temperature');

  return {
    lightIds: lights.map((d) => d.id),
    coverIds: covers.map((d) => d.id),
    allumes: allumes.length,
    lights: lights.length,
    ouverts: positions.filter((c) => c && c.position > 5).length,
    covers: covers.length,
    bougent: positions.filter((c) => c?.moving).length,
    interieur: interieures.length
      ? interieures.reduce((a, b) => a + b, 0) / interieures.length
      : null,
    exterieur: ext ? mesure(ext.id) : null,
  };
});

/** Une alerte muette ne sert à rien : le pH hors plage remonte jusqu'ici. */
const alertes = computed(() => {
  const out: string[] = [];
  const cible = house.config?.pool.phTarget;
  const ph = house.devices.find((d) => d.metric === 'ph');
  if (ph && cible) {
    const st = house.stateOf(ph.id);
    const cap = findCap(st, 'sensor');
    if (cap && st?.health === 'online' && (cap.value < cible[0] || cap.value > cible[1]))
      out.push(`pH du bassin à ${cap.value} : hors de la plage ${cible[0]}–${cible[1]}`);
  }
  const perimes = house.devices.filter((d) => house.stateOf(d.id)?.health === 'stale').length;
  if (perimes)
    out.push(`${perimes} équipement${perimes > 1 ? 's' : ''} ne répond${perimes > 1 ? 'ent' : ''} plus`);
  for (const c of house.connections.filter((c) => c.state === 'error'))
    out.push(`${c.label} : ${c.detail ?? 'en panne'}`);
  return out;
});

const salutation = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
});

const dateLongue = computed(() =>
  new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date())
    .replace(/^./, (c) => c.toUpperCase()),
);

const eteindreTout = () => house.sendBulk(bilan.value.lightIds, { kind: 'switch', state: false });

// ------------------------------------------------- le plan et son panneau

/**
 * Toucher une pièce ouvre son détail À CÔTÉ, sur grand écran.
 *
 * Le plan reste visible pendant qu'on agit, au lieu de disparaître derrière
 * une page. Sur un téléphone la place manque : on navigue, et l'adresse de la
 * pièce sert aussi aux liens profonds et aux raccourcis.
 */
const requete = window.matchMedia('(min-width: 1280px)');
const large = ref(requete.matches);
const selection = ref<string | null>(null);
const suivre = (e: MediaQueryListEvent) => {
  large.value = e.matches;
  if (!e.matches) selection.value = null;
};
requete.addEventListener('change', suivre);
onBeforeUnmount(() => requete.removeEventListener('change', suivre));

const pieceOuverte = computed(() => (selection.value ? house.zone(selection.value) : null));

/**
 * La famille ouverte dans le panneau : éclairage, volets, climat, ouvrants.
 *
 * Elle partage l'emplacement avec le détail de pièce, et les deux s'excluent :
 * deux panneaux superposés au même endroit, ce serait deux réponses à la même
 * question. Choisir une famille referme donc la pièce, et l'inverse.
 */
const categorie = ref<CategorieId | null>(null);

function choisirCategorie(id: CategorieId | null) {
  categorie.value = id;
  if (id) {
    selection.value = null;
    annoncer(`Famille ouverte à côté du plan.`);
  }
}

function ouvrir(zoneId: string) {
  if (!large.value) { void router.push(`/zone/${zoneId}`); return; }
  if (selection.value === zoneId) { fermer(); return; }
  categorie.value = null;
  selection.value = zoneId;
  annoncer(`${house.zone(zoneId)?.label ?? 'Pièce'} ouverte à côté du plan.`);
}

function fermer() {
  const nom = pieceOuverte.value?.label;
  selection.value = null;
  if (nom) annoncer(`${nom} refermée.`);
}

// ------------------------------------------------------------- l'énergie

/**
 * Le mini-graphique de consommation, repris du canvas.
 *
 * Il n'apparaît que si l'écran Énergie a été activé : sans compteur, un
 * histogramme plat n'apprend rien et occupe une carte entière.
 */
const energie = ref<{ kwh: number; seaux: { kwh: number; futur: boolean }[]; watts: number | null } | null>(null);

async function lireEnergie() {
  if (!house.config?.energy?.visible) return;
  try {
    const b = await (await fetch('/api/energy?period=jour')).json();
    energie.value = b.meter ? { kwh: b.kwh, seaux: b.seaux, watts: b.meter.watts } : null;
  } catch {
    energie.value = null;
  }
}

let battement = 0;
onMounted(() => {
  void lireEnergie();
  battement = window.setInterval(lireEnergie, 60_000);
});
onBeforeUnmount(() => clearInterval(battement));

const hautMax = computed(() => Math.max(0.001, ...(energie.value?.seaux ?? []).map((s) => s.kwh)));
</script>

<template>
  <div class="space-y-5">
    <!-- L'en-tête : qui on salue, ce qu'il fait dans la maison, et le geste
         qu'on veut le plus souvent. -->
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="label">{{ salutation }}</p>
        <h1 class="mt-1.5 text-[28px] font-semibold leading-tight tracking-tight lg:text-4xl">
          <template v-if="bilan.allumes">
            {{ bilan.allumes }} éclairage{{ bilan.allumes > 1 ? 's' : '' }} allumé{{ bilan.allumes > 1 ? 's' : '' }}
          </template>
          <template v-else>Tout est éteint</template>
        </h1>
        <p class="mt-2 text-sm text-soft">
          {{ dateLongue }} · {{ house.zones.length }} pièces · {{ house.devices.length }} équipements
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <p v-if="bilan.interieur !== null" class="pastille">
          <Icon name="thermo" :size="15" class="text-faint" />
          <span class="text-soft">Intérieur</span>
          <span class="font-mono font-semibold tabular-nums">{{ bilan.interieur.toFixed(1) }}°</span>
        </p>
        <p v-if="bilan.exterieur !== null" class="pastille">
          <Icon name="soleil" :size="15" class="text-faint" />
          <span class="text-soft">Extérieur</span>
          <span class="font-mono font-semibold tabular-nums">{{ bilan.exterieur.toFixed(1) }}°</span>
        </p>
        <button class="btn" :disabled="!bilan.allumes" @click="eteindreTout">Tout éteindre</button>
      </div>
    </header>

    <div v-if="alertes.length" class="space-y-2">
      <p
        v-for="a in alertes" :key="a"
        class="flex items-start gap-2.5 rounded-2xl border border-crit/40 bg-crit/[0.07] px-4 py-3 text-sm text-crit"
      >
        <Icon name="alerte" :size="17" class="mt-px shrink-0" /><span>{{ a }}</span>
      </p>
    </div>

    <!-- Les quatre familles : la question que le plan ne sait pas poser,
         « où en sont les volets », toutes pièces confondues. -->
    <CategorieRail :choisie="categorie" @choisir="choisirCategorie" />

    <!-- Les cinq équipements qu'on touche tous les jours, avant tout le reste. -->
    <TuilesEpinglees />

    <!-- Le plan à gauche, la pièce ou la famille choisie à droite. -->
    <div
      class="grid gap-4 xl:items-start"
      :class="pieceOuverte ? 'xl:grid-cols-[1fr_minmax(360px,420px)]' : ''"
    >
      <div class="space-y-4">
        <section class="overflow-hidden rounded-[22px] border border-line bg-surface p-3 sm:p-4">
          <HousePlan :selected="selection ?? undefined" @select="ouvrir" />
          <p class="label mt-2 text-center">
            {{ large ? 'Choisissez une pièce' : 'Touchez une pièce' }}
          </p>
        </section>

        <!--
          Scénarios et activité côte à côte.

          La carte « Volets » qui occupait cette place a disparu : le rail des
          familles dit la même chose en tête d'écran : combien d'ouverts,
          combien en mouvement, et son panneau offre en plus le détail pièce
          par pièce. Deux comptages du même bien, c'était un de trop.
        -->
        <div class="grid gap-4 sm:grid-cols-2 sm:items-start">
          <section class="rounded-[22px] border border-line bg-surface p-4">
            <div class="mb-3 flex items-center justify-between">
              <h2 class="label">Scénarios</h2>
              <RouterLink to="/scenarios" class="text-xs font-medium text-glow-deep">Tout voir</RouterLink>
            </div>
            <SceneRow />
          </section>

          <JournalActivite />
        </div>

        <!-- La consommation du jour, si le suivi est allumé. -->
        <section v-if="energie" class="rounded-[22px] border border-line bg-surface p-4">
          <div class="mb-3 flex items-baseline justify-between gap-3">
            <h2 class="label">Aujourd'hui</h2>
            <RouterLink to="/energie" class="text-xs font-medium text-glow-deep">Détail</RouterLink>
          </div>
          <p class="font-mono text-2xl font-semibold tabular-nums leading-none">
            {{ energie.kwh.toFixed(1) }}<span class="ml-1 text-sm font-normal text-faint">kWh</span>
            <span v-if="energie.watts !== null" class="ml-3 text-sm font-normal text-soft">
              {{ Math.round(energie.watts) }} W en ce moment
            </span>
          </p>
          <div class="mt-3 flex h-14 items-end gap-[2px]" aria-hidden="true">
            <div
              v-for="(s, i) in energie.seaux" :key="i"
              class="flex-1 rounded-t"
              :class="s.futur ? 'bg-ink/[0.06]' : 'bg-ink/25'"
              :style="{ height: `${Math.max(2, (s.kwh / hautMax) * 52)}px` }"
            ></div>
          </div>
          <p class="sr-only">Consommation heure par heure, détail sur l'écran Énergie.</p>
        </section>
      </div>

      <!-- Une famille choisie prend la place du détail de pièce : même
           emplacement, même largeur, un seul panneau à la fois. -->
      <aside v-if="categorie">
        <CategorieDetail :categorie="categorie" @fermer="choisirCategorie(null)" />
      </aside>

      <aside v-else-if="pieceOuverte" class="space-y-3">
        <div class="flex items-center justify-between gap-3 px-1">
          <p class="label">Pièce sélectionnée</p>
          <div class="flex items-center gap-1">
            <RouterLink
              :to="`/zone/${pieceOuverte.id}`"
              class="press rounded-lg px-2 py-1.5 text-xs font-medium text-soft transition-colors hover:text-ink"
            >Page entière</RouterLink>
            <button
              class="press rounded-lg px-2 py-1.5 text-xs font-medium text-soft transition-colors hover:text-ink"
              @click="fermer"
            >Fermer</button>
          </div>
        </div>
        <ZoneDetail :zone-id="pieceOuverte.id" compact />
      </aside>
    </div>

    <!--
      La grille de pièces ne sert plus que sous 1280 px, là où le panneau n'a
      pas la place. Au-dessus, le plan dit la même chose en mieux : il montre
      aussi où les pièces sont les unes par rapport aux autres.
    -->
    <section v-if="!large" class="space-y-2.5">
      <h2 class="label px-1">Les pièces</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <RoomCard v-for="z in house.planZones" :key="z.id" :zone="z" />
      </div>
    </section>

    <!--
      Ailleurs : les pièces qui n'ont pas de place sur le plan : le Général, la
      Piscine, l'Extérieur. Une carte plus bavarde qu'ailleurs, parce que ce
      sont justement celles qu'on consulte sans y aller : elle donne les
      mesures et le geste directement, au lieu de renvoyer vers la pièce.
    -->
    <section v-if="house.offPlanZones.length" class="space-y-2.5">
      <h2 class="label px-1">Ailleurs</h2>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <CarteAilleurs v-for="z in house.offPlanZones" :key="z.id" :zone="z" />
      </div>
      <VignettesCameras />
    </section>
  </div>
</template>

<style scoped>
.label { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.pastille {
  @apply flex min-h-[40px] items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm;
}
.press { @apply transition-transform duration-150 active:scale-[0.97] disabled:opacity-40; }
.btn {
  @apply min-h-[40px] shrink-0 rounded-full bg-glow-deep px-5 text-sm font-semibold text-surface
         transition-transform duration-150 active:scale-[0.97] disabled:opacity-40;
}
</style>
