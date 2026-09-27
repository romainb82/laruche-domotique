<script setup lang="ts">
/**
 * L'éditeur de scènes.
 *
 * Le geste central n'est pas de cocher des cases : c'est de **régler la maison
 * comme on la veut, puis de la capturer**. On ne décrit pas « éteins ces onze
 * lampes et ferme ces treize volets » — on met la maison dans l'état voulu et
 * on lui donne un nom.
 *
 * Une scène ne touche QUE les équipements qu'elle liste. Tout ce qui n'y figure
 * pas reste où il est : c'est ce qui permet à « Réveil » d'ouvrir les volets du
 * séjour sans réveiller les chambres.
 */
import { computed, ref } from 'vue';
import {
  decrireRetard, decrireTrigger, findCap, JOURS_COURTS, JOURS_LONGS,
  EN_SEMAINE, LE_WEEKEND, TOUS_LES_JOURS,
  type DeviceConfig, type SceneAction, type SceneConfig,
} from '@domo/shared';
import { useHouse } from '@/stores/house';
import Icon from './Icon.vue';

const props = defineProps<{ scene: SceneConfig }>();
const emit = defineEmits<{ remove: [] }>();

const house = useHouse();
const s = computed(() => props.scene);

const ICONES = ['soleil', 'lune', 'porte', 'ampoule', 'volet', 'thermo', 'piscine', 'eclair', 'maison'] as const;

// ------------------------------------------------------------------- QUAND

/**
 * Passer d'un départ à la main à un départ à heure fixe.
 *
 * On ne se contente pas de changer le genre : on pose une heure et des jours
 * plausibles. Un déclencheur horaire sans jour coché ne partirait jamais, et
 * la validation le refuserait — autant ne jamais créer cet état.
 */
function changerQuand(genre: 'manual' | 'time') {
  s.value.trigger = genre === 'manual'
    ? { kind: 'manual' }
    : { kind: 'time', at: '07:00', days: [...EN_SEMAINE] };
}

function basculerJour(jour: number) {
  const t = s.value.trigger;
  if (t.kind !== 'time') return;
  t.days = t.days.includes(jour) ? t.days.filter((d) => d !== jour) : [...t.days, jour].sort();
}

/** Les trois rythmes qu'on règle en un geste plutôt qu'en sept clics. */
const RACCOURCIS = [
  { cle: 'semaine', libelle: 'En semaine', jours: EN_SEMAINE },
  { cle: 'weekend', libelle: 'Le week-end', jours: LE_WEEKEND },
  { cle: 'tous', libelle: 'Tous les jours', jours: TOUS_LES_JOURS },
] as const;

function poserJours(jours: readonly number[]) {
  const t = s.value.trigger;
  if (t.kind === 'time') t.days = [...jours];
}

const resumeQuand = computed(() => decrireTrigger(s.value.trigger));

// ---------------------------------------------------------------------- SI

/** Les équipements qui savent dire « allumé » ou « éteint ». */
const temoins = computed(() =>
  house.devices.filter((d) => d.type === 'light' || d.type === 'dimmer'),
);

function changerSi(genre: 'always' | 'device') {
  s.value.condition = genre === 'always'
    ? { kind: 'always' }
    : { kind: 'device', deviceId: temoins.value[0]?.id ?? '', is: 'on' };
}

// -------------------------------------------------------------------- ALORS

/**
 * Les retards proposés.
 *
 * Une liste fermée plutôt qu'un champ libre : les cas réels tiennent en six
 * valeurs, et une saisie libre invite surtout à taper 3600 par mégarde.
 */
const RETARDS = [0, 10, 30, 60, 120, 300];

const deviceById = computed(
  () => new Map(house.devices.map((d) => [d.id, d])),
);

/** Les actions rangées par pièce : une scène se relit zone par zone. */
const parZone = computed(() => {
  const groupes = new Map<string, { zone: string; actions: { action: SceneAction; device: DeviceConfig }[] }>();
  for (const action of s.value.actions) {
    const device = deviceById.value.get(action.deviceId);
    if (!device) continue;
    const zone = house.zone(device.zoneId)?.label ?? device.zoneId;
    const g = groupes.get(device.zoneId) ?? { zone, actions: [] };
    g.actions.push({ action, device });
    groupes.set(device.zoneId, g);
  }
  return [...groupes.values()];
});

/** Les équipements orphelins : leur zone ou eux-mêmes ont disparu. */
const fantomes = computed(
  () => s.value.actions.filter((a) => !deviceById.value.has(a.deviceId)).length,
);

// --------------------------------------------------------------- description

/** Ce que fait une action, en français. */
function decrire(action: SceneAction): string {
  const c = action.command;
  switch (c.kind) {
    case 'switch': return c.state ? 'allumer' : 'éteindre';
    case 'dim': return `${c.level} %`;
    case 'cover': return c.position === 0 ? 'fermer' : c.position === 100 ? 'ouvrir' : `${c.position} %`;
    case 'climate': return `${c.setpoint} °C`;
  }
}

function retirer(deviceId: string) {
  s.value.actions = s.value.actions.filter((a) => a.deviceId !== deviceId);
}

function retirerZone(zoneId: string) {
  const ids = new Set(house.devicesOf(zoneId).map((d) => d.id));
  s.value.actions = s.value.actions.filter((a) => !ids.has(a.deviceId));
}

// ----------------------------------------------------------------- capture

/**
 * L'état actuel d'un équipement, traduit en commande de scène.
 * Rend `null` pour ce qui ne se commande pas — un capteur n'a rien à jouer.
 */
function capturer(device: DeviceConfig): SceneAction['command'] | null {
  const etat = house.stateOf(device.id);
  if (!etat) return null;

  if (device.type === 'cover') {
    const c = findCap(etat, 'cover');
    return c ? { kind: 'cover', position: Math.round(c.position) } : null;
  }
  if (device.type === 'thermostat') {
    const c = findCap(etat, 'climate');
    return c ? { kind: 'climate', setpoint: c.setpoint } : null;
  }
  if (device.type === 'dimmer') {
    const allume = findCap(etat, 'switch')?.state;
    const niveau = findCap(etat, 'dim')?.level ?? 100;
    return allume ? { kind: 'dim', level: Math.round(niveau) } : { kind: 'switch', state: false };
  }
  if (device.type === 'light') {
    const c = findCap(etat, 'switch');
    return c ? { kind: 'switch', state: c.state } : null;
  }
  return null;
}

/** Met à jour les valeurs des équipements déjà dans la scène. */
function reprendreEtat() {
  s.value.actions = s.value.actions.map((a) => {
    const device = deviceById.value.get(a.deviceId);
    const commande = device ? capturer(device) : null;
    return commande ? { ...a, command: commande } : a;
  });
  message.value = 'Valeurs reprises sur l’état actuel de la maison.';
}

// ------------------------------------------------------------------- ajout

const ouvrirAjout = ref(false);
const zoneChoisie = ref('');
const message = ref('');

const zonesDisponibles = computed(() =>
  house.zones.filter((z) => house.devicesOf(z.id).some((d) => d.type !== 'sensor')),
);

const candidats = computed(() => {
  if (!zoneChoisie.value) return [];
  const dedans = new Set(s.value.actions.map((a) => a.deviceId));
  return house.devicesOf(zoneChoisie.value)
    .filter((d) => d.type !== 'sensor' && !dedans.has(d.id));
});

function ajouter(device: DeviceConfig) {
  const commande = capturer(device);
  if (!commande) return;
  s.value.actions.push({ deviceId: device.id, command: commande });
}

function ajouterTout() {
  for (const d of candidats.value) ajouter(d);
}

// ------------------------------------------------------------------- essai

const enEssai = ref(false);

/**
 * Joue la scène pour de vrai. C'est le seul moyen honnête de savoir ce
 * qu'elle fait — et le serveur dit combien d'équipements n'ont pas répondu.
 */
async function essayer() {
  enEssai.value = true;
  message.value = '';
  try {
    const res = await fetch(`/api/scenes/${encodeURIComponent(s.value.id)}/apply`, { method: 'POST' });
    const body = await res.json();
    message.value = body.ok
      ? `Jouée — ${body.total} équipements.`
      : `${body.echecs} équipement(s) n'ont pas répondu.`;
  } catch {
    message.value = 'Serveur injoignable.';
  } finally {
    enEssai.value = false;
  }
}
</script>

<template>
  <div class="card space-y-3">
    <!-- identité -->
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1 space-y-2">
        <input v-model="s.label" class="input font-medium" aria-label="Nom de la scène" />
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="i in ICONES" :key="i"
            class="grid h-9 w-9 place-items-center rounded-lg transition-colors"
            :class="s.icon === i ? 'bg-glow text-surface' : 'bg-ink/[0.06] text-faint hover:text-ink'"
            :aria-label="`Icône ${i}`" :aria-pressed="s.icon === i"
            @click="s.icon = i"
          >
            <Icon :name="i" :size="17" />
          </button>
        </div>
      </div>
      <button class="press rounded-lg px-2 py-1 text-xs font-medium text-crit" @click="emit('remove')">
        Supprimer
      </button>
    </div>

    <p class="hint">
      Cette scène ne touche que les {{ s.actions.length }} équipements listés.
      Tout le reste de la maison ne bouge pas.
    </p>

    <!-- ============================================================ QUAND -->
    <div class="space-y-2 rounded-xl border border-line bg-ground p-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="label">Quand</p>
        <label class="flex items-center gap-2 text-xs">
          <input v-model="s.enabled" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" />
          <span>{{ s.enabled ? 'Active' : 'Au repos' }}</span>
        </label>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <button
          class="choix" :class="s.trigger.kind === 'manual' ? 'choix--vif' : ''"
          @click="changerQuand('manual')"
        >À la demande</button>
        <button
          class="choix" :class="s.trigger.kind === 'time' ? 'choix--vif' : ''"
          @click="changerQuand('time')"
        >À heure fixe</button>
      </div>

      <template v-if="s.trigger.kind === 'time'">
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="s.trigger.at" type="time"
            class="input w-32 font-mono" aria-label="Heure de départ"
          />
          <button
            v-for="r in RACCOURCIS" :key="r.cle"
            class="choix" @click="poserJours(r.jours)"
          >{{ r.libelle }}</button>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="(lettre, i) in JOURS_COURTS" :key="i"
            class="grid h-11 w-11 place-items-center rounded-lg text-sm font-medium transition-colors"
            :class="s.trigger.days.includes(i)
              ? 'bg-glow-deep text-surface'
              : 'bg-ink/[0.06] text-soft hover:text-ink'"
            :aria-pressed="s.trigger.days.includes(i)"
            :aria-label="JOURS_LONGS[i]"
            @click="basculerJour(i)"
          >{{ lettre }}</button>
        </div>

        <p v-if="!s.trigger.days.length" class="text-xs text-crit">
          Aucun jour coché : cette scène ne partirait jamais.
        </p>
        <p v-else class="hint">
          {{ resumeQuand }}{{ s.enabled ? '' : ' — mais la scène est au repos.' }}
        </p>
      </template>
      <p v-else class="hint">
        Elle ne part que si on la lance. Elle reste jouable depuis l'accueil,
        l'app iOS et Siri.
      </p>
    </div>

    <!-- =============================================================== SI -->
    <div class="space-y-2 rounded-xl border border-line bg-ground p-2.5">
      <p class="label">Si</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          class="choix" :class="s.condition.kind === 'always' ? 'choix--vif' : ''"
          @click="changerSi('always')"
        >Sans condition</button>
        <button
          class="choix" :class="s.condition.kind === 'device' ? 'choix--vif' : ''"
          @click="changerSi('device')"
        >Selon un équipement</button>
      </div>

      <div v-if="s.condition.kind === 'device'" class="flex flex-wrap items-center gap-2">
        <select v-model="s.condition.deviceId" class="input flex-1" aria-label="Équipement de la condition">
          <option v-for="d in temoins" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
        <select v-model="s.condition.is" class="input w-32" aria-label="État attendu">
          <option value="on">est allumé</option>
          <option value="off">est éteint</option>
        </select>
      </div>
      <p class="hint">
        La condition vaut aussi quand on lance la scène à la main : c'est une
        garde sur l'état de la maison, pas sur l'intention.
      </p>
    </div>

    <p v-if="fantomes" class="rounded-lg border border-warn/40 bg-warn/[0.08] px-3 py-2 text-xs text-warn-deep">
      {{ fantomes }} équipement(s) de cette scène n'existent plus.
    </p>

    <!-- ce que fait la scène, pièce par pièce -->
    <div v-if="parZone.length" class="space-y-2">
      <div v-for="g in parZone" :key="g.zone" class="rounded-xl border border-line bg-ground p-2.5">
        <div class="flex items-center justify-between">
          <p class="label">{{ g.zone }}</p>
          <button
            class="press min-h-[24px] rounded px-1.5 text-[11px] font-medium text-crit"
            @click="retirerZone(g.actions[0]!.device.zoneId)"
          >Retirer la pièce</button>
        </div>
        <div class="mt-1.5 space-y-1">
          <div
            v-for="{ action, device } in g.actions" :key="action.deviceId"
            class="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5"
          >
            <span class="min-w-0 flex-1 truncate text-sm">{{ device.label }}</span>
            <span class="shrink-0 font-mono text-[11px] uppercase tracking-wider text-glow-deep">
              {{ decrire(action) }}
            </span>
            <!--
              Le retard est ce qui transforme une scène en séquence : « tout
              s'éteint, puis les volets se ferment trente secondes après ».
            -->
            <select
              :value="action.afterSeconds ?? 0"
              class="shrink-0 rounded border border-line bg-ground px-1 py-1 text-[11px] text-soft"
              :aria-label="`Retard de ${device.label}`"
              @change="action.afterSeconds = Number(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="r in RETARDS" :key="r" :value="r">{{ decrireRetard(r) }}</option>
            </select>
            <button
              class="press grid h-6 w-6 shrink-0 place-items-center rounded text-xs text-crit" :aria-label="`Retirer ${device.label}`"
              @click="retirer(action.deviceId)"
            >×</button>
          </div>
        </div>
      </div>
    </div>

    <p v-else class="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-soft">
      Scène vide. Règle la maison comme tu la veux, puis ajoute les équipements.
    </p>

    <!-- ajouter -->
    <div class="rounded-xl border border-dashed border-line p-2.5">
      <button
        v-if="!ouvrirAjout"
        class="press w-full rounded-lg py-2 text-sm font-medium text-glow-deep"
        @click="ouvrirAjout = true"
      >+ Ajouter des équipements</button>

      <div v-else class="space-y-2">
        <div class="flex gap-2">
          <select v-model="zoneChoisie" class="input flex-1" aria-label="Pièce">
            <option value="">Choisir une pièce…</option>
            <option v-for="z in zonesDisponibles" :key="z.id" :value="z.id">{{ z.label }}</option>
          </select>
          <button class="press rounded-lg px-3 text-xs font-medium text-soft" @click="ouvrirAjout = false">
            Fermer
          </button>
        </div>

        <div v-if="zoneChoisie" class="space-y-1.5">
          <p class="hint">
            La valeur enregistrée est celle de l'équipement <strong>en ce moment</strong>.
          </p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="d in candidats" :key="d.id"
              class="press rounded-lg bg-ink/[0.06] px-2.5 py-1.5 text-xs hover:bg-glow/15 hover:text-glow-deep"
              @click="ajouter(d)"
            >+ {{ d.label }}</button>
          </div>
          <p v-if="!candidats.length" class="hint">Toute la pièce est déjà dans la scène.</p>
          <button
            v-else class="press rounded-lg bg-glow/10 px-3 py-1.5 text-xs font-medium text-glow-deep"
            @click="ajouterTout"
          >Ajouter toute la pièce</button>
        </div>
      </div>
    </div>

    <!-- reprendre / essayer -->
    <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <button
        class="press rounded-lg bg-ink/[0.06] px-3 py-2 text-xs font-medium"
        :disabled="!s.actions.length"
        @click="reprendreEtat"
      >Reprendre l'état actuel</button>
      <button
        class="press rounded-lg bg-ink/[0.06] px-3 py-2 text-xs font-medium"
        :disabled="enEssai || !s.actions.length"
        @click="essayer"
      >{{ enEssai ? 'Essai…' : 'Essayer' }}</button>
      <p v-if="message" class="text-xs text-soft">{{ message }}</p>
    </div>

    <p class="hint">
      « Reprendre l'état actuel » relit la maison telle qu'elle est et met à jour
      les valeurs des équipements déjà listés. « Essayer » joue la scène pour de
      vrai — le seul moyen honnête de savoir ce qu'elle fait.
    </p>
  </div>
</template>

<style scoped>
.card { @apply rounded-2xl border border-line bg-surface p-4; }
.label { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.input {
  @apply w-full rounded-xl border border-line bg-ground px-3.5 py-2.5 text-sm text-ink
         outline-none transition-colors placeholder:text-faint focus:border-glow;
}
.hint { @apply text-xs leading-relaxed text-soft; }
.press { @apply transition-transform duration-150 active:scale-[0.97] disabled:opacity-40; }
.choix {
  @apply min-h-[36px] rounded-lg border border-line bg-surface px-3 text-xs font-medium text-soft
         transition-colors hover:text-ink;
}
.choix--vif { @apply border-glow/50 bg-glow/10 text-glow-deep; }
</style>
