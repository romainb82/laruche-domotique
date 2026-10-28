<script setup lang="ts">
/**
 * La coquille.
 *
 * Un rail étroit plutôt qu'une colonne large, repris du canvas de refonte. Le
 * raisonnement est celui du contenu : une barre de 224 px prenait un septième
 * d'un écran de bureau pour afficher deux mots et un compteur d'équipements
 * que personne ne lit. À 88 px, l'icône et son libellé tiennent, et la place
 * rendue va au plan de la maison et au panneau de pièce.
 *
 * Ce qui disparaissait avec elle, le nom de la maison et l'état des canaux, ne
 * disparaît pas : le nom est sur l'accueil, et l'état du lien devient une
 * pastille sur le logo, plus visible qu'une ligne de texte gris.
 *
 * Réglages est détaché en bas. C'est une destination qu'on visite rarement et
 * qu'on cherche toujours au même endroit ; la mêler aux pièces et aux
 * scénarios revenait à la noyer.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useHouse } from '@/stores/house';
import { ROLE_LABELS } from '@domo/shared';
import { useAuth } from '@/stores/auth';
import { useAnnonce } from '@/composables/useAnnonce';
import Icon from '@/components/Icon.vue';

const house = useHouse();
const auth = useAuth();
const { message: annonce, annoncer } = useAnnonce();

/**
 * Une commande refusée se DIT. Avant, `house.error` était posé par le magasin
 * et lu par personne : un 403, un équipement périmé ou un serveur muet
 * laissaient la tuile exactement comme avant, sans un mot.
 */
const refus = ref<string | null>(null);
let effacerRefus: number | null = null;
watch(
  () => house.error,
  (e) => {
    if (!e) return;
    refus.value = e;
    annoncer(e);
    if (effacerRefus) clearTimeout(effacerRefus);
    effacerRefus = window.setTimeout(() => { refus.value = null; house.error = null; }, 6000);
  },
);
const route = useRoute();
const router = useRouter();

/**
 * Le menu.
 *
 * Deux entrées sont conditionnelles, pour la même raison : une destination qui
 * mène à un écran vide use la confiance plus qu'elle ne rend service.
 * L'énergie attend d'être activée, la sécurité attend une première caméra.
 */
const LIENS = computed(() => [
  { to: '/', libelle: 'Maison', icone: 'maison' as const },
  { to: '/scenarios', libelle: 'Scénarios', icone: 'eclair' as const },
  ...(house.config?.energy?.visible
    ? [{ to: '/energie', libelle: 'Énergie', icone: 'soleil' as const }]
    : []),
  // Les caméras ne sont pas pour un invité : pas de lien vers un écran refusé.
  ...((house.config?.cameras?.length ?? 0) && auth.peut('habitant')
    ? [{ to: '/securite', libelle: 'Sécurité', icone: 'alerte' as const }]
    : []),
]);

const REGLAGES = { to: '/parametrage', libelle: 'Réglages', icone: 'reglages' as const };

/** Ce que dit la pastille du logo, pour qui la survole ou l'écoute. */
const resume = computed(() => {
  if (!house.connected) return 'serveur injoignable';
  const panne = house.connections.filter((c) => c.state === 'error').length;
  if (panne) return `${panne} canal en panne`;
  const actifs = house.connections.filter((c) => c.state === 'connected').length;
  return `${actifs} canal${actifs > 1 ? 'aux' : ''} actif${actifs > 1 ? 's' : ''}`;
});

/** Une pièce ouverte reste « Maison » : c'est de là qu'on y est entré. */
const actif = (to: string) =>
  to === '/' ? route.path === '/' || route.path.startsWith('/zone') : route.path === to;

/**
 * La maison ne se charge QU'UNE FOIS CONNECTÉ.
 *
 * Avant, le chargement partait au montage : il reviendrait maintenant en 401,
 * et le bandeau « serveur injoignable » s'afficherait derrière la page de
 * connexion alors que le serveur va très bien.
 *
 * `immediate` couvre le cas le plus fréquent : une session encore valable, où
 * `connecte` est déjà vrai quand le composant se monte.
 */
watch(
  () => auth.connecte,
  (ouvert) => {
    if (!ouvert) {
      house.disconnect();
      return;
    }
    // Le lien d'abord : il se relance tout seul, et son ouverture recharge la
    // maison. Un `load()` qui échoue au montage (serveur en train de
    // redémarrer) ne doit pas empêcher le lien de s'ouvrir ensuite.
    house.connect();
    house.load().catch(() => undefined);
  },
  { immediate: true },
);

const menuOuvert = ref(false);

const roleLisible = computed(() => (auth.compte ? ROLE_LABELS[auth.compte.role] : ''));

/**
 * Un menu ouvert doit se refermer tout seul.
 *
 * Deux sorties : la touche Echap, et un clic ailleurs. Sans elles, le menu
 * reste accroche a l'ecran pendant qu'on navigue, ce qui donne l'impression
 * que l'interface a decroche.
 */
function fermerMenu(e: Event) {
  if (!menuOuvert.value) return;
  if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
  menuOuvert.value = false;
}

onMounted(() => {
  document.addEventListener('keydown', fermerMenu);
  document.addEventListener('pointerdown', fermerMenu);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', fermerMenu);
  document.removeEventListener('pointerdown', fermerMenu);
});

async function sortir() {
  menuOuvert.value = false;
  await auth.deconnexion();
  await router.replace('/connexion');
}
</script>

<template>
  <!--
    La page de connexion s'affiche SEULE : ni rail, ni barre du bas, ni bandeau
    de lien. Montrer la navigation de la maison à quelqu'un qui n'y est pas
    encore entré, ce serait lui décrire les pièces depuis le paillasson.
  -->
  <RouterView v-if="!auth.connecte" />

  <div v-else class="min-h-dvh lg:flex">
    <!-- Le rail. Bureau uniquement : sur un téléphone, la barre du bas fait le
         même travail sans manger de largeur. -->
    <aside
      class="sticky top-0 hidden h-dvh w-[88px] shrink-0 flex-col items-center border-r border-line bg-surface py-6 lg:flex"
    >
      <RouterLink
        to="/"
        class="relative grid h-11 w-11 place-items-center rounded-[14px] bg-glow-deep text-surface transition-transform active:scale-95"
        :aria-label="`${house.config?.house.name ?? 'Maison'} : ${resume}`"
      >
        <Icon name="ruche" :size="21" />
        <!-- L'état du lien, là où l'œil revient toujours. -->
        <span
          class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface"
          :class="house.connected ? 'bg-ok' : 'animate-pulse bg-crit'"
        />
      </RouterLink>

      <nav class="mt-7 flex w-full flex-col items-center gap-1 px-2" aria-label="Navigation principale">
        <RouterLink
          v-for="l in LIENS" :key="l.to" :to="l.to"
          class="flex w-16 flex-col items-center gap-1 rounded-[14px] py-2.5 text-[11px] font-medium transition-colors"
          :class="actif(l.to) ? 'bg-glow/[0.1] text-glow-deep' : 'text-soft hover:bg-ink/[0.04] hover:text-ink'"
          :aria-current="actif(l.to) ? 'page' : undefined"
        >
          <Icon :name="l.icone" :size="20" />
          {{ l.libelle }}
        </RouterLink>
      </nav>

      <RouterLink
        :to="REGLAGES.to"
        class="mt-auto flex w-16 flex-col items-center gap-1 rounded-[14px] py-2.5 text-[11px] font-medium transition-colors"
        :class="actif(REGLAGES.to) ? 'bg-glow/[0.1] text-glow-deep' : 'text-soft hover:bg-ink/[0.04] hover:text-ink'"
        :aria-current="actif(REGLAGES.to) ? 'page' : undefined"
      >
        <Icon :name="REGLAGES.icone" :size="20" />
        {{ REGLAGES.libelle }}
      </RouterLink>

      <!--
        Qui est connecté, et par où sortir.

        Un MENU, pas un bouton de déconnexion. Cliquer sur son propre nom pour
        se retrouver dehors est exactement ce qu'on ne veut pas : c'est le
        geste qu'on fait pour vérifier avec quel compte on est, pas pour
        partir.
      -->
      <div class="relative mt-1">
        <button
          type="button"
          class="press grid h-10 w-10 place-items-center rounded-full text-[13px] font-semibold transition-colors"
          :class="menuOuvert ? 'bg-ink text-surface' : 'bg-ink/[0.06] text-soft hover:bg-ink/10 hover:text-ink'"
          :aria-label="`Compte de ${auth.compte?.nom}`"
          :aria-expanded="menuOuvert"
          aria-haspopup="menu"
          @click.stop="menuOuvert = !menuOuvert"
        >
          {{ (auth.compte?.nom ?? '?').slice(0, 1).toUpperCase() }}
        </button>

        <div
          v-if="menuOuvert"
          role="menu"
          class="absolute bottom-0 left-[52px] z-30 w-60 overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
          @click.stop
        >
          <div class="border-b border-line px-4 py-3">
            <p class="truncate text-sm font-semibold">{{ auth.compte?.nom }}</p>
            <p class="truncate font-mono text-xs text-soft">
              {{ auth.compte?.identifiant }} · {{ roleLisible }}
            </p>
          </div>

          <RouterLink
            to="/parametrage"
            role="menuitem"
            class="flex min-h-[44px] items-center gap-2.5 px-4 text-sm hover:bg-ink/[0.04]"
            @click="menuOuvert = false"
          >
            <Icon name="reglages" :size="17" />
            Réglages
          </RouterLink>

          <button
            type="button"
            role="menuitem"
            class="flex min-h-[44px] w-full items-center gap-2.5 border-t border-line px-4 text-left text-sm text-crit hover:bg-crit/[0.06]"
            @click="sortir"
          >
            <Icon name="retour" :size="17" />
            Se déconnecter
          </button>
        </div>
      </div>
    </aside>

    <!-- Contenu : pleine largeur, avec une borne haute pour que les lignes de
         texte restent lisibles sur un 27 pouces. -->
    <div class="min-w-0 flex-1">
      <!--
        Pleine largeur, sans plafond : la maison s'étale sur tout l'écran.
        Un `max-width` centré laissait deux bandes vides sur un grand moniteur,
        alors que le plan et le panneau latéral ont justement besoin de place.
      -->
      <div class="w-full px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">
        <p
          v-if="!house.connected"
          class="mb-5 flex items-center gap-2 rounded-xl border border-crit/40 bg-crit/[0.08] px-3.5 py-2.5 text-sm text-crit"
        >
          <Icon name="alerte" :size="17" />
          Serveur injoignable : les états affichés ne sont plus à jour.
        </p>
        <p
          v-else-if="refus"
          role="alert"
          class="mb-5 flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/[0.08] px-3.5 py-2.5 text-sm text-warn-deep"
        >
          <Icon name="alerte" :size="17" />
          {{ refus }}
        </p>

        <main>
          <RouterView />
        </main>
      </div>
    </div>

    <!-- La voix de l'application : invisible, mais lue par les technologies
         d'assistance a chaque changement important. -->
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ annonce }}</p>

    <!-- Barre du bas : telephone uniquement. Réglages y reprend sa place : sur
         un téléphone il n'y a pas de « bas de barre » où l'isoler. -->
    <nav
      class="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur-xl lg:hidden"
      style="padding-bottom: env(safe-area-inset-bottom)"
      aria-label="Navigation principale"
    >
      <div class="flex">
        <RouterLink
          v-for="l in [...LIENS, REGLAGES]" :key="l.to" :to="l.to"
          class="flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium tracking-wide transition-colors"
          :class="actif(l.to) ? 'text-glow-deep' : 'text-faint'"
          :aria-current="actif(l.to) ? 'page' : undefined"
        >
          <Icon :name="l.icone" :size="21" />
          {{ l.libelle }}
        </RouterLink>
      </div>
    </nav>
  </div>
</template>
