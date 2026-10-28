<script setup lang="ts">
/**
 * Un canal vers le monde extérieur, avec son état vivant.
 *
 * L'essai à blanc est le geste important : on ne demande jamais à quelqu'un
 * d'enregistrer une adresse en espérant qu'elle soit bonne. On essaie, on dit
 * ce qui s'est passé, et alors seulement on enregistre.
 */
import { computed, ref } from 'vue';
import { http } from '@/stores/http';
import {
  CONNECTION_LABELS, MODBUS_ADDRESS_HINT, MODBUS_TABLE_LABELS,
  type Connection, type ConnectionStatus,
} from '@domo/shared';
import Icon from './Icon.vue';
import { useAnnonce } from '@/composables/useAnnonce';

const props = defineProps<{
  connection: Connection;
  status?: ConnectionStatus;
  removable: boolean;
}>();
const emit = defineEmits<{ remove: []; }>();

const c = computed(() => props.connection);
const { annoncer } = useAnnonce();

const essai = ref<{ etat: 'attente' | 'ok' | 'ko'; texte: string } | null>(null);
const enCours = ref(false);

async function tester() {
  enCours.value = true;
  essai.value = { etat: 'attente', texte: 'Connexion en cours…' };
  try {
    const body = await http<{ ok: boolean; ms: number; error?: string }>('/api/connections/test', {
      method: 'POST',
      body: c.value,
      delaiMs: 20_000,
    });
    essai.value = body.ok
      ? { etat: 'ok', texte: `Répond en ${body.ms} ms.` }
      : { etat: 'ko', texte: body.error ?? 'Échec.' };
  } catch (e) {
    essai.value = { etat: 'ko', texte: (e as Error).message };
  } finally {
    enCours.value = false;
    // Dans les deux cas : le resultat d'un essai doit etre dit, pas seulement
    // affiche. C'est l'information que l'utilisateur attend.
    if (essai.value) annoncer(`${c.value.label} : ${essai.value.texte}`);
  }
}

const ETATS = {
  connected: { texte: 'connecté', classe: 'bg-ok/15 text-ok' },
  connecting: { texte: 'en cours', classe: 'bg-warn/15 text-warn' },
  error: { texte: 'en panne', classe: 'bg-crit/15 text-crit' },
  disabled: { texte: 'au repos', classe: 'bg-ink/[0.07] text-faint' },
} as const;

const etat = computed(() => ETATS[props.status?.state ?? 'disabled']);
</script>

<template>
  <div class="card">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1 space-y-1.5">
        <input v-model="c.label" class="input font-medium" aria-label="Nom du canal" />
        <p class="label">{{ CONNECTION_LABELS[c.kind] }} · {{ c.id }}</p>
      </div>
      <span
        class="shrink-0 rounded-md px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider"
        :class="etat.classe"
      >{{ etat.texte }}</span>
    </div>

    <p v-if="status?.detail && status.state === 'error'" class="flex items-start gap-2 text-xs text-crit">
      <Icon name="alerte" :size="14" class="mt-px" />{{ status.detail }}
    </p>

    <!-- MQTT -->
    <template v-if="c.kind === 'mqtt'">
      <label class="field">
        <span>Adresse du broker</span>
        <input v-model="c.settings.url" class="input font-mono text-sm" placeholder="mqtt://192.168.1.10:1883" />
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="field">
          <span>Utilisateur</span>
          <input v-model="c.settings.username" class="input" autocomplete="off" />
        </label>
        <label class="field">
          <span>Mot de passe</span>
          <input v-model="c.settings.password" type="password" class="input" autocomplete="new-password" />
        </label>
      </div>
      <label class="field">
        <span>Préfixe des topics</span>
        <input v-model="c.settings.baseTopic" class="input font-mono text-sm" placeholder="domo" />
      </label>
      <p class="hint">
        Le préfixe borne aussi l'écoute de découverte : sur un broker partagé, on
        n'ira pas fouiller le trafic des voisins.
      </p>
    </template>

    <!-- HTTP -->
    <template v-if="c.kind === 'http'">
      <label class="field">
        <span>Adresse de base</span>
        <input v-model="c.settings.baseUrl" class="input font-mono text-sm" placeholder="http://192.168.1.50/api" />
      </label>
      <label class="field">
        <span>Interrogation (secondes)</span>
        <input v-model.number="c.settings.pollSeconds" type="number" min="2" class="input" />
      </label>
      <p class="hint">
        Les lectures qui partagent un même point d'entrée sont regroupées : une
        seule requête sert tous les capteurs d'une passerelle.
      </p>
    </template>

    <!-- HOME ASSISTANT -->
    <template v-if="c.kind === 'homeassistant'">
      <label class="field">
        <span>Adresse de Home Assistant</span>
        <input
          v-model="c.settings.url"
          class="input font-mono text-sm"
          placeholder="http://192.168.1.40:8123"
        />
      </label>
      <label class="field">
        <span>Jeton d'accès longue durée</span>
        <input
          v-model="c.settings.token"
          type="password"
          autocomplete="off"
          class="input font-mono text-sm"
          placeholder="collez ici le jeton copié dans Home Assistant"
        />
      </label>
      <p class="hint">
        Le jeton se crée dans Home Assistant, en bas de votre page de profil, à
        « Jetons d'accès longue durée ». Il vaut mot de passe et ne ressort
        jamais d'ici.
      </p>
      <p class="hint">
        Les équipements raccordés ici n'ont rien à déclarer d'autre que leur
        identifiant d'entité, par exemple
        <span class="font-mono">light.salon</span>&nbsp;: Home Assistant décrit
        lui-même ce qu'il expose, et le reste s'en déduit.
      </p>
    </template>

    <!-- MODBUS -->
    <template v-if="c.kind === 'modbus'">
      <div class="grid grid-cols-[1fr_auto_auto] gap-3">
        <label class="field">
          <span>Adresse de l'équipement</span>
          <input v-model="c.settings.host" class="input font-mono text-sm" placeholder="192.168.1.60" />
        </label>
        <label class="field">
          <span>Port</span>
          <input v-model.number="c.settings.port" type="number" min="1" class="input w-24" placeholder="502" />
        </label>
        <label class="field">
          <span>Esclave</span>
          <input v-model.number="c.settings.unitId" type="number" min="0" max="255" class="input w-20" />
        </label>
      </div>
      <label class="field">
        <span>Interrogation (secondes)</span>
        <input v-model.number="c.settings.pollSeconds" type="number" min="2" class="input" />
      </label>
      <p class="hint">
        {{ MODBUS_ADDRESS_HINT }}
      </p>

      <div class="rounded-xl border border-dashed border-line p-2.5">
        <p class="label">Balayage</p>
        <p class="hint mt-1">
          Un équipement Modbus ne sait pas dire ce qu'il contient : aucune découverte
          n'est possible. À la place, on lit une plage de registres et on montre ce
          qui s'y trouve, en direct. Mets un nombre au-dessus de zéro, touche à la
          machine, et regarde quelle case bouge.
        </p>
        <div class="mt-2 grid grid-cols-3 gap-2">
          <label class="field">
            <span>Table</span>
            <select v-model="c.settings.scanTable" class="input">
              <option v-for="(libelle, cle) in MODBUS_TABLE_LABELS" :key="cle" :value="cle">{{ cle }}</option>
            </select>
          </label>
          <label class="field">
            <span>À partir de</span>
            <input v-model.number="c.settings.scanFrom" type="number" min="0" class="input" />
          </label>
          <label class="field">
            <span>Combien</span>
            <input v-model.number="c.settings.scanCount" type="number" min="0" max="64" class="input" />
          </label>
        </div>
      </div>
    </template>

    <template v-if="c.kind === 'sim'">
      <p class="hint">
        Toujours actif, et non supprimable. Il sert tout ce qui n'est pas encore
        raccordé : c'est ce qui permet d'équiper la maison pièce par pièce.
      </p>
    </template>

    <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <label class="flex items-center gap-2 text-sm">
        <input v-model="c.enabled" type="checkbox" class="h-6 w-6 accent-[rgb(var(--c-glow))]" :disabled="c.kind === 'sim'" />
        <span>Actif</span>
      </label>

      <button v-if="c.kind !== 'sim'" class="press ml-auto rounded-lg bg-ink/[0.06] px-3 py-1.5 text-xs font-medium" :disabled="enCours" @click="tester">
        {{ enCours ? 'Essai…' : 'Tester' }}
      </button>
      <button v-if="removable" class="press rounded-lg px-2 py-1.5 text-xs font-medium text-crit" @click="emit('remove')">
        Supprimer
      </button>
    </div>

    <p
      v-if="essai"
      class="rounded-lg px-3 py-2 text-xs"
      :class="essai.etat === 'ok' ? 'bg-ok/10 text-ok' : essai.etat === 'ko' ? 'bg-crit/10 text-crit' : 'bg-ink/[0.05] text-soft'"
    >{{ essai.texte }}</p>
  </div>
</template>

<style scoped>
.card { @apply space-y-3 rounded-2xl border border-line bg-surface p-4; }
.field { @apply block space-y-1.5; }
.field > span { @apply block text-xs text-soft; }
.label { @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint; }
.input {
  @apply w-full rounded-xl border border-line bg-ground px-3.5 py-2.5 text-sm text-ink
         outline-none transition-colors placeholder:text-faint focus:border-glow;
}
.hint { @apply text-xs leading-relaxed text-soft; }
.press { @apply transition-transform duration-150 active:scale-[0.97]; }
</style>
