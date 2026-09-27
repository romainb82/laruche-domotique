<script setup lang="ts">
/** Jeu d'icônes minimal, dessiné à la main. Aucune dépendance, aucun CDN. */
defineProps<{ name: keyof typeof PATHS; size?: number }>();

const PATHS = {
  ampoule: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.8.9.9 1.5l.1.6h5l.1-.6c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 3Z',
  volet: 'M4 4h16v16H4zM4 8h16M4 12h16M4 16h16',
  thermo: 'M12 3a2 2 0 0 1 2 2v8.2a4 4 0 1 1-4 0V5a2 2 0 0 1 2-2Z',
  goutte: 'M12 3s5.5 6 5.5 9.5a5.5 5.5 0 1 1-11 0C6.5 9 12 3 12 3Z',
  soleil: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  piscine: 'M3 16c1.5 0 1.5 1.5 3 1.5s1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5M7 14V5a2 2 0 0 1 4 0M13 14V5a2 2 0 0 1 4 0M7 8h10',
  prise: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3',
  porte: 'M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17M3 21h18M13 12h.01',
  maison: 'M3 10.5 12 3l9 7.5M6 9.5V20h12V9.5',
  // La ruche en paille : un dôme, ses anneaux, et l'entrée. Dessinée au trait
  // comme le reste du jeu, pour rester lisible à 20 px comme à 1024.
  ruche: 'M3.2 20.5h17.6M4.8 20.5a7.2 7.2 0 0 1 14.4 0M6.1 16.6h11.8M7.4 12.7h9.2M9.2 8.9h5.6M12 17a1.6 1.6 0 1 0 0 3.2',
  reglages: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.3-3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 3 1.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  chevron: 'm9 6 6 6-6 6',
  retour: 'm15 6-6 6 6 6',
  lune: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  eclair: 'm13 2-9 12h7l-1 8 9-12h-7l1-8Z',
  alerte: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
} as const;
</script>

<template>
  <svg
    :width="size ?? 20" :height="size ?? 20" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" class="shrink-0"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
