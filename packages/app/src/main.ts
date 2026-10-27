import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';

createApp(App).use(createPinia()).use(router).mount('#app');

/*
 * Le service worker, sous deux conditions.
 *
 * `isSecureContext` : les navigateurs ne l'autorisent qu'en HTTPS ou sur
 * localhost. Depuis un téléphone qui ouvre http://192.168.x.x, il ne
 * s'enregistrera pas, et c'est normal. L'ajout à l'écran d'accueil, lui,
 * fonctionne quand même : on ne perd que le démarrage instantané et l'écran
 * « injoignable ».
 *
 * `PROD` : en développement il entrerait en conflit avec le rechargement à
 * chaud de Vite, qui sert des modules que le cache n'a rien à faire de garder.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Un échec ici ne casse rien : l'application fonctionne sans lui.
      console.warn('[pwa] service worker non enregistré :', err);
    });
  });
}

