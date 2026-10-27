import { ref, type Ref } from 'vue';

/**
 * Distingue le TOUCHER du GLISSER sur une même tuile.
 *
 * C'est ce qui permet à une tuile d'être à la fois un interrupteur et un
 * variateur : on la touche pour allumer, on glisse dessus pour régler. Sans
 * cette distinction, il faudrait un appui long : un geste que personne ne
 * découvre tout seul.
 *
 * Le seuil de 8 px est ce qui sépare un doigt qui appuie d'un doigt qui bouge.
 */
export interface TileDrag {
  /** Valeur en cours de glissement, ou null si on ne glisse pas. */
  apercu: Ref<number | null>;
  actif: Ref<boolean>;
  onPointerdown: (e: PointerEvent) => void;
}

export function useTileDrag(options: {
  /** Valeur actuelle, 0–100. */
  valeur: () => number;
  /** Appelée à la fin d'un glissement. */
  onGlisser: (valeur: number) => void;
  /** Appelée sur un simple toucher. */
  onToucher: () => void;
  /** Faux quand l'équipement est injoignable : ni toucher ni glisser. */
  actionnable: () => boolean;
  /** Le glissement monte-t-il avec le doigt (volet) ou l'inverse (lampe) ? */
  sens?: 'haut-plein' | 'bas-plein';
}): TileDrag {
  const apercu = ref<number | null>(null);
  const actif = ref(false);
  const SEUIL = 8;

  function onPointerdown(e: PointerEvent) {
    if (!options.actionnable()) return;
    // Un clic droit ou un second doigt ne doit rien déclencher.
    if (e.button !== 0) return;

    const cible = e.currentTarget as HTMLElement;
    const rect = cible.getBoundingClientRect();
    const depart = { x: e.clientX, y: e.clientY };
    const debut = options.valeur();
    let glisse = false;

    cible.setPointerCapture(e.pointerId);

    const bouge = (ev: PointerEvent) => {
      const dy = ev.clientY - depart.y;
      const dx = ev.clientX - depart.x;
      if (!glisse && Math.hypot(dx, dy) < SEUIL) return;

      if (!glisse) {
        glisse = true;
        actif.value = true;
      }
      // Vers le haut = on augmente. La hauteur de la tuile couvre 0–100 %.
      const delta = (-dy / rect.height) * 100;
      const brut = options.sens === 'haut-plein' ? debut - delta : debut + delta;
      apercu.value = Math.round(Math.min(100, Math.max(0, brut)));
    };

    const relache = (ev: PointerEvent) => {
      cible.releasePointerCapture?.(ev.pointerId);
      cible.removeEventListener('pointermove', bouge);
      cible.removeEventListener('pointerup', relache);
      cible.removeEventListener('pointercancel', annule);

      if (glisse && apercu.value !== null) options.onGlisser(apercu.value);
      else options.onToucher();

      actif.value = false;
      // On garde l'aperçu le temps que le vrai état revienne du matériel :
      // sans ça, la tuile retomberait à l'ancienne valeur pendant un instant.
      setTimeout(() => { apercu.value = null; }, 700);
    };

    const annule = () => {
      cible.removeEventListener('pointermove', bouge);
      cible.removeEventListener('pointerup', relache);
      cible.removeEventListener('pointercancel', annule);
      apercu.value = null;
      actif.value = false;
    };

    cible.addEventListener('pointermove', bouge);
    cible.addEventListener('pointerup', relache);
    cible.addEventListener('pointercancel', annule);
  }

  return { apercu, actif, onPointerdown };
}
