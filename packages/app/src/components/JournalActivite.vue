<script setup lang="ts">
/**
 * Ce qui vient de se passer dans la maison.
 *
 * Le sous-titre « confirmée par le matériel » n'est pas un ornement : le
 * journal n'enregistre que des commandes dont l'équipement a accusé réception.
 * Une commande partie mais restée sans retour y figure en `timeout`, et se
 * voit : c'est précisément l'information qui manque partout ailleurs.
 *
 * L'intérêt principal est `wall_switch` : quelqu'un a appuyé sur un
 * interrupteur mural. C'est la seule trace qu'une application domotique puisse
 * donner d'un geste qu'elle n'a pas provoqué.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { http } from '@/stores/http';
import type { ActionLogEntry } from '@domo/shared';
import { useHouse } from '@/stores/house';

const props = withDefaults(defineProps<{ limite?: number }>(), { limite: 6 });

const house = useHouse();
const entrees = ref<ActionLogEntry[]>([]);
const chargement = ref(true);

/** D'où vient le geste. `ui`, c'est nous : inutile de le dire. */
const ORIGINES: Record<string, string> = {
  schedule: 'scénario programmé',
  rule: 'règle',
  wall_switch: 'interrupteur mural',
  system: 'système',
};

const RESULTATS: Record<string, string> = {
  timeout: 'sans réponse',
  rejected: 'refusée',
};

async function charger() {
  try {
    entrees.value = (await http<{ entries: ActionLogEntry[] }>('/api/journal')).entries ?? [];
  } catch {
    /* le bandeau global dit déjà que le serveur est injoignable */
  } finally {
    chargement.value = false;
  }
}

/**
 * Vingt secondes : le journal s'écrit côté serveur et le flux temps réel ne le
 * diffuse pas. Plus court ferait un appel pour rien la plupart du temps, plus
 * long donnerait l'impression que l'écran a décroché.
 */
let minuterie = 0;
onMounted(() => {
  charger();
  minuterie = window.setInterval(charger, 20_000);
});
onBeforeUnmount(() => clearInterval(minuterie));

/** Ce que la commande a fait, en français. */
function decrire(e: ActionLogEntry): string {
  const d = house.devices.find((x) => x.id === e.deviceId);
  const nom = d?.label ?? e.deviceId;
  const piece = d ? house.zone(d.zoneId)?.label : null;
  const ou = piece ? ` · ${piece}` : '';
  const c = e.command;

  if (c.kind === 'switch') return `${nom} ${c.state ? 'allumé' : 'éteint'}${ou}`;
  if (c.kind === 'dim') return `${nom} à ${c.level} %${ou}`;
  if (c.kind === 'cover') {
    if (c.position === 0) return `${nom} fermé${ou}`;
    if (c.position === 100) return `${nom} ouvert${ou}`;
    return `${nom} à ${c.position} %${ou}`;
  }
  if (c.kind === 'climate') return `${nom} réglé sur ${c.setpoint} °${ou}`;
  return `${nom}${ou}`;
}

const heure = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const lignes = computed(() =>
  entrees.value.slice(0, props.limite).map((e) => ({
    cle: `${e.at}-${e.deviceId}`,
    heure: heure(e.at),
    texte: decrire(e),
    confirme: e.outcome === 'confirmed',
    // Un échec se nomme ; une origine `ui` ne s'annonce pas, c'est nous.
    note: RESULTATS[e.outcome] ?? ORIGINES[e.origin] ?? '',
  })),
);
</script>

<template>
  <section class="rounded-[22px] border border-line bg-surface p-4">
    <div class="mb-3 flex items-baseline justify-between gap-3">
      <h2 class="label">Activité</h2>
      <span class="text-xs text-soft">confirmée par le matériel</span>
    </div>

    <p v-if="chargement" class="py-2 text-sm text-soft">Lecture du journal…</p>

    <p v-else-if="!lignes.length" class="py-2 text-sm text-soft">
      Rien depuis le dernier démarrage.
    </p>

    <ol v-else class="space-y-2.5">
      <li
        v-for="l in lignes"
        :key="l.cle"
        class="grid grid-cols-[8px_46px_minmax(0,1fr)] items-start gap-2.5"
      >
        <span
          class="mt-[5px] h-2 w-2 shrink-0 rounded-full"
          :class="l.confirme ? 'bg-ok' : 'bg-crit'"
        ></span>
        <span class="font-mono text-xs tabular-nums text-faint">{{ l.heure }}</span>
        <span class="flex min-w-0 flex-col">
          <span class="text-sm leading-tight">{{ l.texte }}</span>
          <span v-if="l.note" class="text-[11px] text-soft">{{ l.note }}</span>
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.label {
  @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint;
}
</style>
