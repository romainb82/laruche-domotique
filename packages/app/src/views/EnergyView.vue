<script setup lang="ts">
/**
 * La consommation de la maison.
 *
 * Tout ce qui est affiché ici est MESURÉ, jamais déduit. C'est la contrainte
 * qui donne sa forme à l'écran :
 *
 *   · le total vient de l'intégration des relevés de puissance, pas d'une
 *     estimation ;
 *   · le coût n'apparaît que si un tarif a été saisi : un montant en euros
 *     calculé sur un prix inventé serait pire qu'une case vide ;
 *   · la répartition par usage n'existe pas, et l'écran le dit. Un compteur
 *     général ne sait pas quelle part revient au chauffage : il faudrait une
 *     mesure par circuit.
 *
 * La couverture est affichée dès qu'elle descend : un serveur arrêté laisse un
 * trou dans l'historique, et un total qui paraît complet sans l'être est
 * exactement le genre de mensonge que ce projet refuse.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { http } from '@/stores/http';
import { PERIODE_LABELS, type Periode } from '@domo/shared';
import Icon from '@/components/Icon.vue';

interface Seau { label: string; kwh: number; futur: boolean }
interface Bilan {
  period: Periode;
  titre: string;
  comparaison: string;
  meter: { id: string; label: string; watts: number | null; joignable: boolean } | null;
  message?: string;
  kwh: number;
  precedent: number;
  cout: number | null;
  prixKwh: number;
  pic: { kwh: number; label: string } | null;
  seaux: Seau[];
  couverture: number;
}

const periode = ref<Periode>('jour');
const bilan = ref<Bilan | null>(null);
const chargement = ref(true);
const erreur = ref<string | null>(null);

async function charger() {
  chargement.value = true;
  erreur.value = null;
  try {
    bilan.value = await http(`/api/energy?period=${periode.value}`);
  } catch (e) {
    bilan.value = null;
    erreur.value = (e as Error).message;
  } finally {
    chargement.value = false;
  }
}

onMounted(charger);
watch(periode, charger);

// La puissance de l'instant bouge tout le temps : on rafraîchit doucement.
const battement = window.setInterval(charger, 30_000);
onBeforeUnmount(() => clearInterval(battement));

/** L'écart avec la période précédente, en points de pourcentage. */
const ecart = computed(() => {
  const b = bilan.value;
  if (!b || !b.precedent) return null;
  return Math.round(((b.kwh - b.precedent) / b.precedent) * 100);
});

const hauteurMax = computed(() =>
  Math.max(0.001, ...(bilan.value?.seaux ?? []).map((s) => s.kwh)),
);

/**
 * Les libellés affichés sous les barres.
 *
 * Vingt-quatre heures ne tiennent pas en vingt-quatre étiquettes sur un
 * téléphone : on en garde une sur six, et le lecteur d'écran a de toute façon
 * le tableau complet.
 */
function montrerLabel(i: number): boolean {
  const n = bilan.value?.seaux.length ?? 0;
  if (n <= 8) return true;
  if (n === 24) return i % 6 === 0;
  return i % 5 === 0;
}

const unite = computed(() => (periode.value === 'jour' ? 'par heure' : 'par jour'));
const prefixePic = computed(() => (periode.value === 'jour' ? 'à ' : periode.value === 'mois' ? 'le ' : ''));
</script>

<template>
  <div class="space-y-7">
    <header class="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="label">Consommation</p>
        <h1 class="mt-1.5 text-[28px] font-semibold leading-tight tracking-tight lg:text-4xl">
          Énergie
        </h1>
        <p v-if="bilan?.meter" class="mt-2 text-sm text-soft">
          Mesurée par « {{ bilan.meter.label }} »
          <span v-if="bilan.meter.watts !== null && bilan.meter.joignable">
            · <span class="font-mono tabular-nums">{{ Math.round(bilan.meter.watts) }} W</span> en ce moment
          </span>
          <span v-else-if="bilan.meter">· compteur injoignable</span>
        </p>
      </div>

      <!-- Le choix de période : trois boutons, pas un menu déroulant. -->
      <div role="group" aria-label="Période" class="flex gap-1 rounded-full border border-line bg-surface p-1">
        <button
          v-for="(libelle, cle) in PERIODE_LABELS" :key="cle"
          class="min-h-[36px] rounded-full px-4 text-sm font-medium transition-colors"
          :class="periode === cle ? 'bg-glow-deep text-surface' : 'text-soft hover:text-ink'"
          :aria-pressed="periode === cle"
          @click="periode = cle as Periode"
        >{{ libelle }}</button>
      </div>
    </header>

    <p v-if="erreur" class="rounded-2xl border border-crit/40 bg-crit/[0.07] px-4 py-3 text-sm text-crit">
      Consommation indisponible : {{ erreur }}
    </p>

    <!-- Aucun compteur : on dit quoi faire, on ne montre pas un écran vide. -->
    <p
      v-else-if="bilan && !bilan.meter"
      class="rounded-2xl border border-dashed border-line px-6 py-12 text-center text-sm text-soft"
    >
      {{ bilan.message }}
    </p>

    <template v-else-if="bilan">
      <!-- Le chiffre, son écart, son coût, son pic. -->
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="carte">
          <p class="nom">{{ bilan.titre }}</p>
          <p class="chiffre">{{ bilan.kwh.toFixed(1) }}<span class="sur">kWh</span></p>
        </div>

        <div class="carte">
          <p class="nom">Évolution</p>
          <p v-if="ecart !== null" class="chiffre" :class="ecart <= 0 ? 'text-ok' : 'text-glow-deep'">
            {{ ecart > 0 ? '+' : '' }}{{ ecart }}<span class="sur">%</span>
          </p>
          <p v-else class="chiffre text-faint">-</p>
          <p class="hint">{{ bilan.comparaison }}</p>
        </div>

        <div class="carte">
          <p class="nom">Coût estimé</p>
          <p v-if="bilan.cout !== null" class="chiffre">
            {{ bilan.cout.toFixed(2) }}<span class="sur">€</span>
          </p>
          <template v-else>
            <p class="chiffre text-faint">-</p>
            <p class="hint">
              Tarif non renseigné.
              <RouterLink to="/parametrage" class="font-medium text-glow-deep underline">
                Le saisir
              </RouterLink>
            </p>
          </template>
        </div>

        <div class="carte">
          <p class="nom">Pic</p>
          <p v-if="bilan.pic" class="chiffre">
            {{ bilan.pic.kwh.toFixed(2) }}<span class="sur">kWh</span>
          </p>
          <p v-else class="chiffre text-faint">-</p>
          <p v-if="bilan.pic" class="hint">{{ prefixePic }}{{ bilan.pic.label }}</p>
        </div>
      </section>

      <!-- L'histogramme. Un lecteur d'écran reçoit le tableau, pas l'image. -->
      <figure class="space-y-3 rounded-[22px] border border-line bg-surface p-4 sm:p-5">
        <figcaption class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="label">{{ bilan.titre }}</h2>
          <span class="hint">kWh {{ unite }}</span>
        </figcaption>

        <div class="flex h-48 items-end gap-[3px]" aria-hidden="true">
          <div
            v-for="(s, i) in bilan.seaux" :key="i"
            class="flex min-w-0 flex-1 flex-col items-center gap-1.5"
          >
            <div
              class="w-full rounded-t transition-all duration-500"
              :class="s.futur ? 'bg-ink/[0.06]'
                : bilan.pic && s.kwh === bilan.pic.kwh ? 'bg-glow-deep' : 'bg-ink/25'"
              :style="{ height: `${Math.max(2, (s.kwh / hauteurMax) * 160)}px` }"
            ></div>
            <span class="h-3 font-mono text-[9px] text-faint">
              {{ montrerLabel(i) ? s.label : '' }}
            </span>
          </div>
        </div>

        <table class="sr-only">
          <caption>Consommation {{ unite }} : {{ bilan.titre }}</caption>
          <thead><tr><th scope="col">Période</th><th scope="col">kWh</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in bilan.seaux.filter((x) => !x.futur)" :key="i">
              <th scope="row">{{ s.label }}</th>
              <td>{{ s.kwh.toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </figure>

      <!-- Ce qu'on ne sait pas, dit plutôt que masqué. -->
      <section class="space-y-2">
        <p
          v-if="bilan.couverture < 0.95"
          class="flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn/[0.08] px-4 py-3 text-sm text-warn-deep"
        >
          <Icon name="alerte" :size="17" class="mt-px shrink-0" />
          <span>
            {{ Math.round(bilan.couverture * 100) }} % de la période seulement ont été mesurés.
            Le total est celui du temps couvert, pas de la période entière.
          </span>
        </p>

        <p class="rounded-2xl border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-soft">
          Un seul compteur mesure ici la maison entière. La part du chauffage, de
          l'eau chaude ou de la cuisine ne s'en déduit pas : il faudrait une
          mesure par circuit, au tableau, ou des prises mesurantes. Tant qu'elles
          n'existent pas, cet écran s'en tient à ce qu'il sait.
        </p>
      </section>
    </template>

    <p v-else-if="chargement" class="py-16 text-center text-soft">Lecture des mesures…</p>
  </div>
</template>

<style scoped>
.carte   { @apply rounded-[22px] border border-line bg-surface px-4 py-3.5; }
.nom     { @apply font-mono text-[10px] uppercase tracking-[0.12em] text-soft; }
.chiffre { @apply mt-1 font-mono text-[28px] font-semibold tabular-nums leading-none; }
.sur     { @apply ml-1 text-sm font-normal text-faint; }
.hint    { @apply mt-1.5 text-xs leading-relaxed text-soft; }
.label   { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
</style>
