<script setup lang="ts">
/**
 * Les comptes de la maison.
 *
 * Reserve aux administrateurs. Le serveur le verifie aussi, et c'est LUI qui
 * fait foi : cet ecran ne fait que ne pas proposer ce qui serait refuse.
 *
 * Trois gardes-fous sont poses par le serveur, et repetes ici pour que la
 * personne comprenne AVANT de cliquer plutot qu'apres :
 *   . on ne modifie pas ses propres droits ;
 *   . on ne supprime pas son propre compte ;
 *   . il doit toujours rester un administrateur actif.
 */
import { computed, onMounted, ref } from 'vue';
import { http } from '@/stores/http';
import {
  MOT_DE_PASSE_MIN,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  validerIdentifiant,
  validerMotDePasse,
  validerNom,
  type Compte,
  type Role,
} from '@domo/shared';
import { useAuth } from '@/stores/auth';
import Icon from '@/components/Icon.vue';

const auth = useAuth();

const comptes = ref<Compte[]>([]);
const sessions = ref<{ id: string; appareil: string; vueLe: string; courante: boolean }[]>([]);
const erreur = ref<string | null>(null);
const succes = ref<string | null>(null);
const chargement = ref(true);

/** Le compte ouvert dans le panneau de modification, ou `'nouveau'`. */
const ouvert = ref<string | null>(null);

const neuf = ref({ identifiant: '', nom: '', role: 'habitant' as Role, motDePasse: '' });
const nouveauMdp = ref<Record<string, string>>({});
const aSupprimer = ref<string | null>(null);

// --------------------------------------------------------------- les appels

/** Un seul chemin pour tous les appels : un seul endroit ou lire l'erreur. */
async function appel(url: string, options: RequestInit = {}): Promise<unknown | null> {
  erreur.value = null;
  try {
    return await http(url, {
      method: (options.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      body: options.body ? JSON.parse(options.body as string) : undefined,
    });
  } catch (e) {
    erreur.value = (e as Error).message;
    return null;
  }
}

async function charger() {
  const d = (await appel('/api/comptes')) as { comptes?: Compte[] } | null;
  if (d?.comptes) comptes.value = d.comptes;
  const s = (await appel('/api/auth/sessions')) as { sessions?: typeof sessions.value } | null;
  if (s?.sessions) sessions.value = s.sessions;
  chargement.value = false;
}

onMounted(charger);

function annoncer(message: string) {
  succes.value = message;
  // Le message s'efface tout seul : un bandeau de reussite qui reste colle a
  // l'ecran finit par decrire une action dont on ne se souvient plus.
  window.setTimeout(() => {
    if (succes.value === message) succes.value = null;
  }, 4000);
}

// --------------------------------------------------------------- la creation

const refusNeuf = computed(() => {
  if (!neuf.value.identifiant && !neuf.value.nom && !neuf.value.motDePasse) return null;
  return (
    validerIdentifiant(neuf.value.identifiant) ??
    validerNom(neuf.value.nom) ??
    validerMotDePasse(neuf.value.motDePasse, neuf.value.identifiant)
  );
});

async function creer() {
  const refus =
    validerIdentifiant(neuf.value.identifiant) ??
    validerNom(neuf.value.nom) ??
    validerMotDePasse(neuf.value.motDePasse, neuf.value.identifiant);
  if (refus) {
    erreur.value = refus;
    return;
  }
  const d = await appel('/api/comptes', { method: 'POST', body: JSON.stringify(neuf.value) });
  if (!d) return;
  annoncer(`${neuf.value.nom} peut maintenant se connecter.`);
  neuf.value = { identifiant: '', nom: '', role: 'habitant', motDePasse: '' };
  ouvert.value = null;
  await charger();
}

// ----------------------------------------------------------- la modification

async function modifier(c: Compte, champs: { nom?: string; role?: Role; actif?: boolean }) {
  const d = await appel(`/api/comptes/${c.id}`, { method: 'PATCH', body: JSON.stringify(champs) });
  if (!d) return;
  annoncer(`${c.nom} mis à jour.`);
  await charger();
}

async function reinitialiser(c: Compte) {
  const mdp = nouveauMdp.value[c.id] ?? '';
  const refus = validerMotDePasse(mdp, c.identifiant);
  if (refus) {
    erreur.value = refus;
    return;
  }
  const d = await appel(`/api/comptes/${c.id}/mot-de-passe`, {
    method: 'POST',
    body: JSON.stringify({ motDePasse: mdp }),
  });
  if (!d) return;
  nouveauMdp.value[c.id] = '';
  annoncer(`Mot de passe de ${c.nom} remplacé. Ses sessions ouvertes sont fermées.`);
  await charger();
}

async function supprimer(c: Compte) {
  const d = await appel(`/api/comptes/${c.id}`, { method: 'DELETE' });
  aSupprimer.value = null;
  if (!d) return;
  annoncer(`Compte de ${c.nom} supprimé.`);
  await charger();
}

async function fermerSession(id: string) {
  await appel(`/api/auth/sessions/${id}`, { method: 'DELETE' });
  annoncer('Appareil déconnecté.');
  await charger();
}

async function fermerLesAutres() {
  const d = (await appel('/api/auth/sessions', { method: 'DELETE' })) as {
    fermees?: number;
  } | null;
  if (!d) return;
  annoncer(`${d.fermees} appareil${(d.fermees ?? 0) > 1 ? 's' : ''} déconnecté${(d.fermees ?? 0) > 1 ? 's' : ''}.`);
  await charger();
}

/**
 * Un plafond d'affichage.
 *
 * Les scripts de verification ouvrent une session a chaque passage, et la
 * liste en comptait plusieurs centaines. Une page qui deroule sur dix ecrans
 * ne se lit pas : on montre les plus recentes, et on dit combien restent.
 */
const PLAFOND = 8;
const toutVoir = ref(false);
const sessionsVues = computed(() =>
  toutVoir.value ? sessions.value : sessions.value.slice(0, PLAFOND),
);
const cachees = computed(() => Math.max(0, sessions.value.length - PLAFOND));

// ----------------------------------------------------------- l'affichage

const moi = computed(() => auth.compte?.id ?? '');

const quand = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : 'jamais';

/** Pourquoi une action est impossible, ou `null` si elle ne l'est pas. */
function blocage(c: Compte, action: 'modifier' | 'supprimer'): string | null {
  if (c.id === moi.value)
    return action === 'supprimer'
      ? 'On ne supprime pas son propre compte.'
      : 'Vous ne pouvez pas modifier vos propres droits.';
  const admins = comptes.value.filter((x) => x.role === 'admin' && x.actif).length;
  if (c.role === 'admin' && c.actif && admins <= 1)
    return 'Il doit rester au moins un administrateur actif.';
  return null;
}
</script>

<template>
  <div class="space-y-4">
    <p
      v-if="erreur"
      role="alert"
      class="flex items-start gap-2.5 rounded-2xl border border-crit/30 bg-crit/[0.07] px-4 py-3 text-sm text-crit"
    >
      <Icon name="alerte" :size="16" class="mt-px shrink-0" />
      <span>{{ erreur }}</span>
    </p>

    <p
      v-if="succes"
      role="status"
      class="flex items-start gap-2.5 rounded-2xl border border-ok/30 bg-ok/[0.07] px-4 py-3 text-sm text-ok"
    >
      <Icon name="maison" :size="16" class="mt-px shrink-0" />
      <span>{{ succes }}</span>
    </p>

    <!-- ===================================================== les comptes -->
    <section class="card">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-title !mb-0">Comptes</h2>
        <button
          type="button"
          class="press rounded-xl bg-ink px-3.5 py-2.5 text-sm font-medium text-surface"
          @click="ouvert = ouvert === 'nouveau' ? null : 'nouveau'"
        >
          {{ ouvert === 'nouveau' ? 'Annuler' : 'Ajouter un compte' }}
        </button>
      </div>

      <p v-if="chargement" class="mt-3 text-sm text-soft">Lecture des comptes…</p>

      <!-- La creation -->
      <div
        v-if="ouvert === 'nouveau'"
        class="mt-4 space-y-3 rounded-2xl border border-line bg-ground p-4"
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="field">
            <span>Identifiant</span>
            <input
              v-model="neuf.identifiant"
              class="input"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              placeholder="melissa"
            />
          </label>
          <label class="field">
            <span>Nom affiché</span>
            <input v-model="neuf.nom" class="input" placeholder="Mélissa" />
          </label>
        </div>

        <label class="field">
          <span>Mot de passe</span>
          <input
            v-model="neuf.motDePasse"
            type="password"
            autocomplete="new-password"
            class="input"
            :placeholder="`${MOT_DE_PASSE_MIN} caractères au minimum`"
          />
        </label>

        <fieldset class="space-y-2">
          <legend class="mb-1 text-sm font-medium">Rôle</legend>
          <label
            v-for="r in ROLES"
            :key="r"
            class="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-3"
            :class="neuf.role === r ? 'border-glow bg-glow/[0.06]' : 'border-line bg-surface'"
          >
            <input
              v-model="neuf.role"
              type="radio"
              :value="r"
              class="mt-0.5 h-5 w-5 accent-glow-deep"
            />
            <span class="flex min-w-0 flex-col">
              <span class="text-sm font-medium">{{ ROLE_LABELS[r] }}</span>
              <span class="text-xs leading-relaxed text-soft">{{ ROLE_DESCRIPTIONS[r] }}</span>
            </span>
          </label>
        </fieldset>

        <p v-if="refusNeuf" class="text-sm text-crit">{{ refusNeuf }}</p>

        <button
          type="button"
          class="press w-full rounded-xl bg-glow-deep py-3 text-sm font-semibold text-surface disabled:opacity-50"
          :disabled="Boolean(refusNeuf) || !neuf.identifiant"
          @click="creer"
        >
          Créer le compte
        </button>
      </div>

      <!-- La liste -->
      <ul v-if="comptes.length" class="mt-4 space-y-2.5">
        <li
          v-for="c in comptes"
          :key="c.id"
          class="rounded-2xl border border-line bg-surface p-4"
          :class="c.actif ? '' : 'opacity-60'"
        >
          <div class="flex flex-wrap items-center gap-3">
            <span
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-glow/15 text-sm font-semibold text-glow-deep"
            >{{ [...c.nom][0]?.toUpperCase() }}</span>

            <div class="flex min-w-0 flex-1 flex-col">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-semibold">{{ c.nom }}</span>
                <span
                  v-if="c.id === moi"
                  class="rounded-full bg-ink/[0.07] px-2 py-0.5 text-[11px] text-soft"
                >vous</span>
                <span
                  v-if="!c.actif"
                  class="rounded-full bg-crit/10 px-2 py-0.5 text-[11px] text-crit"
                >désactivé</span>
              </span>
              <span class="truncate font-mono text-xs text-soft">
                {{ c.identifiant }} · {{ ROLE_LABELS[c.role] }} · vu {{ quand(c.derniereConnexion) }}
              </span>
            </div>

            <button
              type="button"
              class="press shrink-0 rounded-xl bg-ink/[0.06] px-3 py-2.5 text-xs font-medium hover:bg-ink/10"
              @click="ouvert = ouvert === c.id ? null : c.id"
            >
              {{ ouvert === c.id ? 'Fermer' : 'Modifier' }}
            </button>
          </div>

          <!-- Le panneau de modification -->
          <div v-if="ouvert === c.id" class="mt-4 space-y-3 border-t border-line pt-4">
            <p v-if="blocage(c, 'modifier')" class="text-xs text-soft">
              {{ blocage(c, 'modifier') }}
            </p>

            <div class="grid gap-3 sm:grid-cols-2">
              <label class="field">
                <span>Nom affiché</span>
                <input
                  :value="c.nom"
                  class="input"
                  @change="modifier(c, { nom: ($event.target as HTMLInputElement).value })"
                />
              </label>

              <label class="field">
                <span>Rôle</span>
                <select
                  class="input"
                  :value="c.role"
                  :disabled="Boolean(blocage(c, 'modifier'))"
                  @change="modifier(c, { role: ($event.target as HTMLSelectElement).value as Role })"
                >
                  <option v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span>Nouveau mot de passe</span>
              <span class="flex gap-2">
                <input
                  v-model="nouveauMdp[c.id]"
                  type="password"
                  autocomplete="new-password"
                  class="input flex-1"
                  :placeholder="`${MOT_DE_PASSE_MIN} caractères au minimum`"
                />
                <button
                  type="button"
                  class="press shrink-0 rounded-xl bg-ink/[0.06] px-3.5 text-sm font-medium hover:bg-ink/10 disabled:opacity-50"
                  :disabled="!nouveauMdp[c.id]"
                  @click="reinitialiser(c)"
                >
                  Remplacer
                </button>
              </span>
            </label>
            <p class="text-xs text-soft">
              Remplacer le mot de passe ferme toutes les sessions ouvertes de ce compte.
            </p>

            <div class="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                class="press rounded-xl bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium hover:bg-ink/10 disabled:opacity-50"
                :disabled="Boolean(blocage(c, 'modifier'))"
                @click="modifier(c, { actif: !c.actif })"
              >
                {{ c.actif ? 'Désactiver' : 'Réactiver' }}
              </button>

              <button
                v-if="aSupprimer !== c.id"
                type="button"
                class="press rounded-xl px-3.5 py-2.5 text-sm font-medium text-crit hover:bg-crit/[0.08] disabled:opacity-50"
                :disabled="Boolean(blocage(c, 'supprimer'))"
                @click="aSupprimer = c.id"
              >
                Supprimer
              </button>

              <!-- La confirmation se fait sur place : une boite de dialogue du
                   navigateur bloque tout et se clique sans la lire. -->
              <template v-else>
                <span class="flex items-center text-sm text-crit">Supprimer définitivement&nbsp;?</span>
                <button
                  type="button"
                  class="press rounded-xl bg-crit px-3.5 py-2.5 text-sm font-semibold text-surface"
                  @click="supprimer(c)"
                >
                  Oui, supprimer
                </button>
                <button
                  type="button"
                  class="press rounded-xl bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium"
                  @click="aSupprimer = null"
                >
                  Annuler
                </button>
              </template>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- ================================================== mes appareils -->
    <section class="card">
      <h2 class="card-title">Mes appareils connectés</h2>
      <p class="-mt-1 mb-3 text-sm text-soft">
        Les sessions ouvertes avec votre compte. Fermez-en une si vous ne reconnaissez pas
        l'appareil.
      </p>

      <div v-if="sessions.length > 1" class="mb-3">
        <button
          type="button"
          class="press rounded-xl bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium hover:bg-ink/10"
          @click="fermerLesAutres"
        >
          Déconnecter tous les autres appareils
        </button>
      </div>

      <ul class="space-y-2">
        <li
          v-for="s in sessionsVues"
          :key="s.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3"
        >
          <span class="flex min-w-0 flex-col">
            <span class="text-sm font-medium">
              {{ s.appareil }}
              <span v-if="s.courante" class="ml-1.5 text-xs font-normal text-ok">cet appareil</span>
            </span>
            <span class="font-mono text-xs text-soft">vu {{ quand(s.vueLe) }}</span>
          </span>
          <button
            v-if="!s.courante"
            type="button"
            class="press shrink-0 rounded-xl bg-ink/[0.06] px-3 py-2.5 text-xs font-medium hover:bg-ink/10"
            @click="fermerSession(s.id)"
          >
            Déconnecter
          </button>
        </li>
      </ul>

      <button
        v-if="cachees && !toutVoir"
        type="button"
        class="press mt-3 text-sm font-medium text-glow-deep"
        @click="toutVoir = true"
      >
        Voir les {{ cachees }} autres
      </button>
    </section>
  </div>
</template>

<style scoped>
/*
 * Les classes d'ecran, redeclarees ici.
 *
 * Elles existent deja dans SettingsView, mais un `<style scoped>` ne traverse
 * PAS vers un composant enfant : Vue n'appose son attribut que sur les
 * elements du gabarit qui le declare. Sans ce bloc, cet ecran n'heritait que
 * du `.card` global de `style.css`, qui ne porte ni espacement interieur ni
 * rythme vertical, et le contenu touchait les bords des cartes.
 *
 * C'est la convention du projet : SceneEditor et ConnectionCard font de meme.
 * Les centraliser dans `style.css` serait plus propre, mais leurs definitions
 * ont diverge (SceneEditor n'a pas `space-y-3`), et uniformiser changerait le
 * rendu de ces ecrans-la sans qu'on l'ait demande.
 */
.card {
  @apply space-y-3 rounded-2xl border border-line bg-surface p-4;
}
.card-title {
  @apply font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint;
}
.field {
  @apply block space-y-1.5;
}
.field > span {
  @apply block text-xs text-soft;
}
.input {
  @apply w-full rounded-xl border border-line bg-ground px-3.5 py-2.5 text-sm text-ink
    outline-none transition-colors placeholder:text-faint focus:border-glow;
}
</style>
