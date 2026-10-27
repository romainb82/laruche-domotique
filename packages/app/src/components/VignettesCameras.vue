<script setup lang="ts">
/**
 * Deux vignettes de caméra au bas de « Ailleurs », comme dans la maquette.
 *
 * Deux, pas plus : c'est un aperçu, pas l'écran Sécurité. On veut savoir d'un
 * regard s'il y a quelqu'un devant la porte, et cliquer pour le reste.
 *
 * Rafraîchissement volontairement lent : une image toutes les quinze secondes.
 * L'écran Sécurité tient la cadence rapide ; ici, chaque seconde gagnée coûte
 * une requête sur le Raspberry Pi, pour une image qu'on regarde en passant.
 *
 * Si aucune caméra n'est déclarée, le composant ne rend rien du tout : une
 * rangée de cadres vides n'apprendrait rien à personne.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

interface Camera {
  id: string;
  label: string;
  enabled: boolean;
  order: number;
}

const cameras = ref<Camera[]>([]);
const jeton = ref(Date.now());
const recues = ref<Record<string, number>>({});
const ratees = ref<Record<string, boolean>>({});

const visibles = computed(() =>
  cameras.value
    .filter((c) => c.enabled)
    .sort((a, b) => a.order - b.order)
    .slice(0, 2),
);

let minuterie = 0;

onMounted(async () => {
  try {
    const r = await fetch('/api/cameras');
    if (r.ok) cameras.value = ((await r.json())?.cameras ?? []) as Camera[];
  } catch {
    /* le bandeau global signale déjà un serveur injoignable */
  }
  if (visibles.value.length) {
    minuterie = window.setInterval(() => {
      jeton.value = Date.now();
    }, 15_000);
  }
});

onBeforeUnmount(() => clearInterval(minuterie));

const url = (c: Camera) => `/api/cameras/${encodeURIComponent(c.id)}/snapshot?t=${jeton.value}`;

const heure = (ms: number) =>
  new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/**
 * Trois états, trois signes : un tiret si l'image n'est pas venue, des points
 * de suspension tant qu'on attend la première, l'heure de réception sinon.
 */
function horodatage(id: string): string {
  if (ratees.value[id]) return '-';
  const recue = recues.value[id];
  return recue ? heure(recue) : '…';
}
</script>

<template>
  <div v-if="visibles.length" class="flex gap-2">
    <RouterLink
      v-for="c in visibles"
      :key="c.id"
      to="/securite"
      class="press relative min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-ink/90"
    >
      <img
        :src="url(c)"
        :alt="`Vue de la caméra ${c.label}`"
        class="block aspect-video w-full object-cover"
        @load="recues[c.id] = Date.now()"
        @error="ratees[c.id] = true"
      />
      <!--
        L'horodatage est celui de l'image REÇUE, pas de l'instant présent : une
        caméra qui a cessé de répondre afficherait sinon sa dernière vue avec
        une heure fraîche, ce qui est exactement le mensonge qu'une caméra ne
        doit pas faire.
      -->
      <span
        class="absolute inset-x-2 bottom-1.5 flex items-center justify-between gap-2 text-[11px] text-surface"
      >
        <span class="truncate font-semibold">{{ c.label }}</span>
        <span class="shrink-0 font-mono tabular-nums">{{ horodatage(c.id) }}</span>
      </span>
    </RouterLink>
  </div>
</template>
