import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';
import { useAuth } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // La seule page qui s'ouvre sans compte. `public` est lu par la garde en
    // bas de fichier : ouvrir une page, c'est poser ce drapeau, et nulle part
    // ailleurs.
    {
      path: '/connexion',
      name: 'connexion',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
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

/**
 * La garde. Aucune page, hormis la connexion, ne s'ouvre sans compte.
 *
 * Elle double la garde du serveur, elle ne la remplace pas. Celle-ci est
 * confortable, puisqu'elle évite d'afficher une coquille vide, mais une garde côté
 * navigateur se contourne en deux clics. Ce qui protège réellement la maison,
 * c'est le `onRequest` du serveur.
 */
router.beforeEach(async (to) => {
  const auth = useAuth();

  // Un seul aller-retour par chargement de page : ensuite l'état est connu.
  if (!auth.pret) await auth.verifier();

  if (to.meta.public) {
    // Déjà connecté et pourtant sur la page de connexion : on renvoie à
    // l'accueil plutôt que de proposer de se reconnecter.
    return auth.connecte ? { path: '/' } : true;
  }

  if (auth.connecte) return true;

  // `redirect` garde en mémoire où l'on allait : un lien profond vers une
  // pièce doit y mener après la connexion, pas à l'accueil.
  return { path: '/connexion', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
});
