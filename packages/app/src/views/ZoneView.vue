<script setup lang="ts">
/**
 * La page d'une pièce.
 *
 * Elle n'est plus qu'un cadre : tout le détail vit dans `ZoneDetail`, partagé
 * avec le panneau posé à côté du plan. Sur grand écran on n'arrive plus ici en
 * touchant le plan — le panneau suffit et évite l'aller-retour — mais
 * l'adresse reste valable, et c'est elle que portent un lien profond, un
 * raccourci Siri ou un widget.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ZoneDetail from '@/components/ZoneDetail.vue';
import Icon from '@/components/Icon.vue';

const route = useRoute();
const zoneId = computed(() => String(route.params.id));
</script>

<template>
  <div class="space-y-7">
    <RouterLink
      to="/"
      class="-ml-1 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-sm text-soft transition-colors hover:text-ink"
    >
      <Icon name="retour" :size="16" /> Maison
    </RouterLink>

    <ZoneDetail :zone-id="zoneId" />
  </div>
</template>
