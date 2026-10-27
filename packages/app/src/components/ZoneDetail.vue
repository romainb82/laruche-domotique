<script setup lang="ts">
/**
 * Le détail d'une pièce.
 *
 * L'idée directrice : en entrant, on doit pouvoir agir sur la pièce ENTIÈRE
 * avant de descendre dans le détail. D'où l'arc en tête : il commande d'un
 * geste toutes les lampes de la pièce, ou sa consigne de chauffage quand il y
 * en a une. Le détail équipement par équipement vient après.
 *
 * Le même bloc sert à deux endroits : la page d'une pièce sur mobile, et le
 * panneau posé à côté du plan sur grand écran. En mode `compact` il se resserre
 * : titre plus petit, colonnes empilées, mais il ne perd aucune commande :
 * une version amputée obligerait à changer de page pour la moindre action, ce
 * que le panneau est justement là pour éviter.
 */
import { computed, ref, watch } from 'vue';
import { findCap, type DeviceConfig } from '@domo/shared';
import { useHouse } from '@/stores/house';
import DeviceControl from '@/components/DeviceControl.vue';
import RadialDial from '@/components/RadialDial.vue';
import Icon from '@/components/Icon.vue';

const props = defineProps<{ zoneId: string; compact?: boolean }>();
const house = useHouse();

const zoneId = computed(() => props.zoneId);
const zone = computed(() => house.zone(zoneId.value));
const devices = computed(() => house.devicesOf(zoneId.value));

const eclairages = computed(() => devices.value.filter((d) => d.type === 'light' || d.type === 'dimmer'));
const variables = computed(() => devices.value.filter((d) => d.type === 'dimmer'));
const volets = computed(() => devices.value.filter((d) => d.type === 'cover'));
const chauffage = computed(() => devices.value.filter((d) => d.type === 'thermostat'));
const capteurs = computed(() => devices.value.filter((d) => d.type === 'sensor'));

const allumes = computed(
  () => eclairages.value.filter((d) => findCap(house.stateOf(d.id), 'switch')?.state === true).length,
);
const ids = (l: { id: string }[]) => l.map((d) => d.id);

// ------------------------------------------------------------- l'arc de tête

/**
 * Ce que l'arc commande, par ordre d'utilité : le chauffage s'il y en a un,
 * sinon la lumière de la pièce, sinon la position des volets.
 */
type Mode = 'climat' | 'lumiere' | 'volets' | 'aucun';

const mode = computed<Mode>(() => {
  if (chauffage.value.length) return 'climat';
  if (eclairages.value.length) return 'lumiere';
  if (volets.value.length) return 'volets';
  return 'aucun';
});

const climat = computed(() => findCap(house.stateOf(chauffage.value[0]?.id ?? ''), 'climate'));

/** Niveau moyen des lampes allumées : 0 si la pièce est éteinte. */
const niveauLumiere = computed(() => {
  const on = eclairages.value.filter((d) => findCap(house.stateOf(d.id), 'switch')?.state === true);
  if (!on.length) return 0;
  const total = on.reduce((s, d) => s + (findCap(house.stateOf(d.id), 'dim')?.level ?? 100), 0);
  return Math.round(total / on.length);
});

const ouvertureVolets = computed(() => {
  const pos = volets.value
    .map((d) => findCap(house.stateOf(d.id), 'cover')?.position)
    .filter((p): p is number => p !== undefined);
  return pos.length ? Math.round(pos.reduce((a, b) => a + b, 0) / pos.length) : 0;
});

/**
 * Aperçu local pendant le geste. Sans lui, l'arc reviendrait en arrière entre
 * chaque envoi, le temps que le matériel confirme.
 */
const apercu = ref<number | null>(null);
watch(() => props.zoneId, () => { apercu.value = null; });
let relache: number | null = null;
function poserApercu(v: number) {
  apercu.value = v;
  if (relache) clearTimeout(relache);
  relache = window.setTimeout(() => { apercu.value = null; }, 1400);
}

const cadran = computed(() => {
  switch (mode.value) {
    case 'climat': {
      const c = climat.value;
      const min = house.config?.heating.minSetpoint ?? 14;
      const max = house.config?.heating.maxSetpoint ?? 24;
      const v = apercu.value ?? c?.setpoint ?? min;
      return {
        valeur: v, min, max, pas: 0.5, unite: '°', teinte: 'glow' as const,
        legende: c ? `${c.ambient.toFixed(1)}° mesurés` : 'hors ligne',
        texte: v.toFixed(1), desactive: !c,
      };
    }
    case 'lumiere': {
      const v = apercu.value ?? niveauLumiere.value;
      return {
        valeur: v, min: 0, max: 100, pas: 5, unite: '%', teinte: 'glow' as const,
        legende: allumes.value ? `${allumes.value} allumé${allumes.value > 1 ? 's' : ''}` : 'éteint',
        texte: String(Math.round(v)), desactive: false,
      };
    }
    case 'volets': {
      const v = apercu.value ?? ouvertureVolets.value;
      return {
        valeur: v, min: 0, max: 100, pas: 5, unite: '%', teinte: 'jour' as const,
        legende: v === 0 ? 'fermés' : v === 100 ? 'ouverts' : 'entrouverts',
        texte: String(Math.round(v)), desactive: false,
      };
    }
    default:
      return null;
  }
});

function reglerCadran(v: number) {
  poserApercu(v);
  if (mode.value === 'climat') {
    const t = chauffage.value[0];
    if (t) void house.send(t.id, { kind: 'climate', setpoint: v });
    return;
  }
  if (mode.value === 'lumiere') {
    // Une pièce qu'on met à zéro s'éteint ; sinon on règle ce qui sait varier
    // et on allume simplement ce qui ne sait pas.
    if (v === 0) { void house.sendBulk(ids(eclairages.value), { kind: 'switch', state: false }); return; }
    if (variables.value.length) void house.sendBulk(ids(variables.value), { kind: 'dim', level: Math.max(5, v) });
    const simples = eclairages.value.filter((d) => d.type === 'light');
    if (simples.length) void house.sendBulk(ids(simples), { kind: 'switch', state: true });
    return;
  }
  if (mode.value === 'volets') void house.sendBulk(ids(volets.value), { kind: 'cover', position: v });
}

// ------------------------------------------------------------------ ambiance

/** Les mesures d'ambiance montent en tête : elles décrivent la pièce. */
const ambiance = computed(() => {
  const cherche = (m: string) => {
    const d = capteurs.value.find((x) => x.metric === m);
    if (!d) return null;
    const st = house.stateOf(d.id);
    const cap = findCap(st, 'sensor');
    return cap && st?.health === 'online' ? { valeur: cap.value, unite: cap.unit } : null;
  };
  const sortie: { cle: string; icone: 'thermo' | 'goutte' | 'soleil'; valeur: number; unite: string }[] = [];
  for (const [cle, icone] of [['temperature', 'thermo'], ['humidity', 'goutte'], ['lux', 'soleil']] as const) {
    const m = cherche(cle);
    if (m) sortie.push({ cle, icone, valeur: m.valeur, unite: m.unite });
  }
  return sortie;
});

/** Les capteurs déjà résumés en tête ne sont pas répétés dans la grille. */
const capteursRestants = computed(() => {
  const vus = new Set(ambiance.value.map((a) => a.cle));
  return capteurs.value.filter((d) => !d.metric || !vus.has(d.metric));
});

const groupes = computed(
  () =>
    [
      { titre: 'Éclairage', items: eclairages.value },
      { titre: 'Volets', items: volets.value },
      { titre: 'Chauffage', items: chauffage.value },
      { titre: 'Mesures', items: capteursRestants.value },
    ].filter((g) => g.items.length) as { titre: string; items: DeviceConfig[] }[],
);
</script>

<template>
  <div v-if="zone" :class="compact ? 'space-y-5' : 'space-y-7'">
    <!-- L'en-tête de pièce : identité, ambiance, et la commande d'ensemble. -->
    <section class="overflow-hidden rounded-[26px] border border-line bg-surface">
      <div :class="compact ? 'grid' : 'grid lg:grid-cols-[1fr_auto]'">
        <div class="flex flex-col justify-between gap-6 p-5" :class="compact ? '' : 'sm:p-7'">
          <div>
            <p class="label">{{ devices.length }} équipements</p>
            <!--
              En panneau, la page porte déjà son titre : un second h1 casserait
              le plan de lecture d'un lecteur d'écran.
            -->
            <component
              :is="compact ? 'h2' : 'h1'"
              class="mt-1.5 font-semibold leading-none tracking-tight"
              :class="compact ? 'text-[26px]' : 'text-[32px] sm:text-5xl'"
            >
              {{ zone.label }}
            </component>

            <dl v-if="ambiance.length" class="mt-6 flex flex-wrap gap-x-7 gap-y-3">
              <div v-for="a in ambiance" :key="a.cle" class="flex items-center gap-2">
                <Icon :name="a.icone" :size="17" class="text-faint" />
                <dd class="font-mono text-xl font-semibold tabular-nums">
                  {{ a.valeur }}<span class="text-xs text-soft">{{ a.unite }}</span>
                </dd>
              </div>
            </dl>
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              v-if="eclairages.length" class="action" :class="allumes ? 'action--vive' : ''"
              @click="house.sendBulk(ids(eclairages), { kind: 'switch', state: allumes === 0 })"
            >{{ allumes ? 'Éteindre la pièce' : 'Allumer la pièce' }}</button>
            <button v-if="volets.length" class="action" @click="house.sendBulk(ids(volets), { kind: 'cover', position: 0 })">
              Fermer les volets
            </button>
            <button v-if="volets.length" class="action" @click="house.sendBulk(ids(volets), { kind: 'cover', position: 100 })">
              Ouvrir les volets
            </button>
          </div>
        </div>

        <div
          v-if="cadran"
          class="flex items-center justify-center border-t border-line p-5"
          :class="compact ? '' : 'sm:p-7 lg:border-l lg:border-t-0'"
        >
          <RadialDial
            :valeur="cadran.valeur" :min="cadran.min" :max="cadran.max" :pas="cadran.pas"
            :texte="cadran.texte" :unite="cadran.unite" :legende="cadran.legende"
            :teinte="cadran.teinte" :desactive="cadran.desactive"
            @update:valeur="reglerCadran"
          />
        </div>
      </div>
    </section>

    <section v-for="g in groupes" :key="g.titre" class="space-y-2.5">
      <h2 class="label px-1">{{ g.titre }}</h2>
      <div class="grille">
        <DeviceControl v-for="d in g.items" :key="d.id" :device="d" />
      </div>
    </section>

    <p v-if="!devices.length" class="rounded-[22px] border border-dashed border-line px-6 py-12 text-center text-sm text-soft">
      Aucun équipement ici.
      <RouterLink to="/parametrage" class="font-medium text-glow-deep underline">En ajouter</RouterLink>
    </p>
  </div>

  <p v-else class="py-16 text-center text-soft">Zone inconnue.</p>
</template>

<style scoped>
/*
 * Densité naturelle : les tuiles gardent une taille lisible à toutes les
 * largeurs, au lieu de s'étirer sur un 27 pouces.
 */
.grille {
  @apply grid gap-3;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
}
@media (max-width: 400px) {
  .grille { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.action {
  @apply rounded-full border border-line bg-ground px-4 py-2.5 text-sm font-medium text-soft
         transition-all duration-200 hover:border-glow/45 hover:text-glow-deep active:scale-[0.97];
}
.action--vive { @apply border-glow/50 bg-glow/10 text-glow-deep; }
</style>
