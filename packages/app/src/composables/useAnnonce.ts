import { ref } from 'vue';

/**
 * La voix de l'application.
 *
 * Tout ce que l'interface montre par un changement visuel — une scene jouee,
 * un canal qui tombe, un volet qui arrive — doit aussi pouvoir etre DIT. Sans
 * ca, un lecteur d'ecran ne saura jamais que la commande a abouti : il faudrait
 * que le focus se trouve pile sur le bon element au bon instant.
 *
 * Une seule region live pour toute l'application, montee dans App.vue.
 */
const message = ref('');
let effacer: number | null = null;

export function useAnnonce() {
  /**
   * `annoncer('')` puis le texte : re-emettre un message identique ne
   * declencherait aucune annonce si la valeur ne change pas.
   */
  function annoncer(texte: string) {
    if (!texte) return;
    message.value = '';
    requestAnimationFrame(() => { message.value = texte; });

    if (effacer) clearTimeout(effacer);
    // On vide au bout d'un moment pour ne pas laisser un message perime
    // dans l'arbre d'accessibilite.
    effacer = window.setTimeout(() => { message.value = ''; }, 8000);
  }

  return { message, annoncer };
}
