import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'maison', component: HomeView },
    { path: '/zone/:id', name: 'zone', component: () => import('@/views/ZoneView.vue') },
    // L'écran existe toujours : le réglage le retire du menu, pas de
    // l'application. Un lien profond, un signet ou l'audit d'accessibilité
    // doivent continuer de l'atteindre.
    { path: '/scenarios', name: 'scenarios', component: () => import('@/views/ScenariosView.vue') },
    { path: '/energie', name: 'energie', component: () => import('@/views/EnergyView.vue') },
    { path: '/securite', name: 'securite', component: () => import('@/views/CamerasView.vue') },
    // L'ancienne adresse reste valable : des captures et des signets la portent.
    { path: '/cameras', redirect: '/securite' },
    { path: '/parametrage', name: 'parametrage', component: () => import('@/views/SettingsView.vue') },
  ],
});
