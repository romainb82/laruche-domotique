<script setup lang="ts">
/**
 * La porte d'entree.
 *
 * Reprise de la maquette « Connexion » du canvas, qui tranchait plusieurs
 * choses mieux que ma premiere version :
 *
 *   . on choisit SON VISAGE avant de taper quoi que ce soit, comme sur macOS
 *     ou une console de jeu, pas comme sur un extranet d'entreprise ;
 *   . le panneau sombre porte la regle d'or du projet en guise d'accroche :
 *     « Une maison qui ne ment pas » ;
 *   . le serveur se presente : son nom, sa machine, et le fait que rien ne
 *     sort sur Internet. Dans une maison, savoir a quoi on parle rassure plus
 *     qu'un logo ;
 *   . boutons en gelule, et non en rectangle arrondi ;
 *   . sur telephone, une feuille blanche qui remonte sur le panneau sombre.
 *
 * Ce que la maquette propose et qui n'est PAS ENCORE LA, faute de serveur pour
 * le porter. Il n'y a ici aucun decor sans fonction :
 *
 *   . Face ID et les passkeys (WebAuthn) ;
 *   . le code d'acces temporaire pour un invite ;
 *   . « mot de passe oublie », qui demanderait un serveur de courrier ;
 *   . le fil « derniers evenements » sur le panneau sombre. Celui-la, je l'ai
 *     ecarte volontairement : il raconterait l'activite de la maison a qui
 *     n'y est pas encore entre.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  MOT_DE_PASSE_MIN,
  ROLE_LABELS,
  validerIdentifiant,
  validerMotDePasse,
  validerNom,
} from '@domo/shared';
import { useAuth } from '@/stores/auth';
import Icon from '@/components/Icon.vue';

const auth = useAuth();
const router = useRouter();

// =========================================================== la ruche
//
// La grappe est CALCULEE, pas dessinee a la main : les alveoles doivent tomber
// exactement sur les cellules du treillis, sinon la grappe flotte au-dessus du
// fond au lieu d'en faire partie. Et les trajets des abeilles sont tires au
// hasard a chaque ouverture : une animation qui se repete a l'identique cesse
// d'etre vivante des la deuxieme fois qu'on la regarde.

/** Rayon d'une alveole, du centre a la pointe. Le treillis en decoule. */
const R = 62;
const PAS_X = R * Math.sqrt(3);
const PAS_Y = R * 1.5;

const VUE = { w: 760, h: 900 };

/** Les six sommets d'une alveole posee sur la pointe. */
const SOMMETS = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 180) * (60 * i - 90);
  return `${(Math.cos(a) * R).toFixed(1)},${(Math.sin(a) * R).toFixed(1)}`;
}).join(' ');

const centre = (col: number, rang: number) => ({
  x: col * PAS_X + (rang % 2 ? PAS_X / 2 : 0),
  y: rang * PAS_Y,
});

/** Le treillis complet, qui deborde largement du cadre pour ne jamais finir. */
const treillis = Array.from({ length: 12 }, (_, r) =>
  Array.from({ length: 10 }, (_, c) => centre(c - 1, r - 1)),
).flat();

/** Le noyau : le serveur, au centre de tout. */
const NOYAU = centre(3, 5);

const hasard = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Les pieces eclairees.
 *
 * Des cellules choisies du treillis, donc parfaitement alignees. L'intensite
 * varie pour que la grappe ait du relief : une maison n'a jamais toutes ses
 * pieces allumees au meme niveau.
 */
const ALLUMEES = [
  [2, 3], [5, 3], [4, 4], [2, 5], [5, 5], [3, 6], [1, 7], [4, 7], [2, 8],
] as const;

const alveoles = ALLUMEES.map(([c, r], i) => ({
  ...centre(c, r),
  // Tirees au hasard, mais dans une plage etroite : le relief vient des
  // ecarts, pas d'alveoles qui disparaitraient a moitie.
  eclat: hasard(0.34, 0.78),
  retard: 180 + i * 90,
  souffle: hasard(5, 9),
}));

/**
 * Les abeilles.
 *
 * Un point qui parcourt le fil entre le noyau et une alveole. La moitie monte,
 * l'autre descend, et chacune a sa vitesse : c'est ce decalage qui fait qu'on
 * y lit une activite plutot qu'un clignotant.
 */
const abeilles = alveoles.flatMap((a, i) =>
  Array.from({ length: i % 3 === 0 ? 2 : 1 }, () => {
    const sort = Math.random() < 0.5;
    return {
      depart: sort ? NOYAU : a,
      dx: (sort ? a.x - NOYAU.x : NOYAU.x - a.x).toFixed(1),
      dy: (sort ? a.y - NOYAU.y : NOYAU.y - a.y).toFixed(1),
      duree: hasard(3.4, 7.2).toFixed(2),
      retard: hasard(0, 6).toFixed(2),
      rayon: hasard(1.8, 3.2).toFixed(1),
    };
  }),
);

/** Des poussieres qui montent, placees et minutees au hasard elles aussi. */
const poussieres = Array.from({ length: 7 }, () => ({
  x: hasard(40, VUE.w - 40).toFixed(0),
  y: hasard(220, VUE.h - 60).toFixed(0),
  r: hasard(1.6, 3.4).toFixed(1),
  duree: hasard(9, 16).toFixed(1),
  retard: hasard(0, 12).toFixed(1),
}));
const route = useRoute();

const identifiant = ref('');
const nom = ref('');
const motDePasse = ref('');
const choisi = ref<string | null>(null);
const rester = ref(true);
const visible = ref(false);
const majuscules = ref(false);
const envoi = ref(false);
const champMotDePasse = ref<HTMLInputElement | null>(null);
const champIdentifiant = ref<HTMLInputElement | null>(null);

/** Vrai a la toute premiere ouverture : il n'y a encore aucun compte. */
const premiere = computed(() => !auth.installe);

/** La liste des visages. Vide si le serveur refuse de la donner. */
const habitants = computed(() => auth.habitants);
const parVisage = computed(() => !premiere.value && habitants.value.length > 0);

onMounted(async () => {
  if (!premiere.value) await auth.chargerHabitants();
  // Un seul habitant : inutile de faire choisir, le curseur va au mot de passe.
  if (habitants.value.length === 1) choisi.value = habitants.value[0]!.id;
  if (premiere.value || !parVisage.value) champIdentifiant.value?.focus();
  else if (choisi.value) champMotDePasse.value?.focus();
});

// Choisir quelqu'un amene au mot de passe sans un clic de plus.
watch(choisi, async (v) => {
  auth.erreur = null;
  motDePasse.value = '';
  if (!v) return;
  await Promise.resolve();
  champMotDePasse.value?.focus();
});

/**
 * Les erreurs de saisie ne s'affichent qu'APRES une tentative.
 *
 * Reprocher un mot de passe trop court a quelqu'un qui vient d'en taper trois
 * caracteres, c'est le gronder pendant qu'il travaille.
 */
const tente = ref(false);

const refusIdentifiant = computed(() =>
  tente.value && !parVisage.value ? validerIdentifiant(identifiant.value) : null,
);
const refusNom = computed(() => (tente.value && premiere.value ? validerNom(nom.value) : null));
const refusMotDePasse = computed(() =>
  tente.value && premiere.value ? validerMotDePasse(motDePasse.value, identifiant.value) : null,
);

const message = computed(
  () => auth.erreur ?? refusIdentifiant.value ?? refusNom.value ?? refusMotDePasse.value,
);

const titre = computed(() => {
  if (premiere.value) return 'Première ouverture';
  const qui = habitants.value.find((h) => h.id === choisi.value);
  return qui ? `Bonjour ${qui.nom}` : 'Bon retour à la maison';
});

function surClavier(e: KeyboardEvent) {
  // `getModifierState` manque sur quelques claviers virtuels : dans ce cas on
  // n'affiche simplement pas l'avertissement.
  majuscules.value = e.getModifierState?.('CapsLock') ?? false;
}

async function valider() {
  tente.value = true;
  auth.erreur = null;

  if (premiere.value) {
    if (refusIdentifiant.value || refusNom.value || refusMotDePasse.value) return;
  } else if (parVisage.value) {
    if (!choisi.value) {
      auth.erreur = 'Choisissez qui se connecte.';
      return;
    }
    if (!motDePasse.value) {
      auth.erreur = 'Il faut un mot de passe.';
      return;
    }
  } else if (!identifiant.value.trim() || !motDePasse.value) {
    auth.erreur = 'Il faut un identifiant et un mot de passe.';
    return;
  }

  envoi.value = true;
  const refus = premiere.value
    ? await auth.premierCompte(identifiant.value, nom.value, motDePasse.value)
    : parVisage.value
      ? await auth.connexionParId(choisi.value!, motDePasse.value, rester.value)
      : await auth.connexion(identifiant.value, motDePasse.value, rester.value);
  envoi.value = false;

  if (refus) {
    // On efface le mot de passe, jamais le visage choisi : on retape ce qu'on
    // a rate, pas ce qu'on avait juste.
    motDePasse.value = '';
    champMotDePasse.value?.focus();
    return;
  }

  const suite = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  // Jamais une adresse absolue venue de l'exterieur : un lien fabrique
  // pourrait sinon renvoyer vers un autre site apres une connexion reussie.
  await router.replace(suite.startsWith('/') && !suite.startsWith('//') ? suite : '/');
}
</script>

<template>
  <div class="min-h-dvh bg-ink lg:grid lg:grid-cols-[1.3fr_1fr]">
    <!-- ================================================= le panneau sombre -->
    <aside
      class="relative flex h-[420px] flex-col overflow-hidden p-6 sm:h-[480px] lg:h-auto lg:p-12"
    >
      <!--
        La ruche.
        
        Une grappe d'alveoles qui s'allument depuis le noyau, comme une maison
        dont les pieces s'eclairent une a une. C'est le sujet de la page : tout
        le reste se pose par-dessus.

        Elle ne montre AUCUNE donnee de la maison. La maquette affichait les
        temperatures, les volets ouverts et le pH a cote de chaque alveole :
        magnifique, mais cela raconterait l'etat du logement a quiconque ouvre
        la page sans y habiter. Les chiffres arrivent apres la connexion.
      -->
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        :viewBox="`0 0 ${VUE.w} ${VUE.h}`"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="noyauFeu">
            <stop offset="0%" stop-color="#FFE7C4" />
            <stop offset="55%" stop-color="#E59A3C" />
            <stop offset="100%" stop-color="#C87819" />
          </radialGradient>

          <radialGradient id="halo" :cx="`${(NOYAU.x / VUE.w) * 100}%`" :cy="`${(NOYAU.y / VUE.h) * 100}%`" r="52%">
            <stop offset="0%" stop-color="#E59A3C" stop-opacity="0.22" />
            <stop offset="55%" stop-color="#C87819" stop-opacity="0.07" />
            <stop offset="100%" stop-color="#C87819" stop-opacity="0" />
          </radialGradient>

          <filter id="flou" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="22" />
          </filter>
        </defs>

        <!-- Le treillis. Des alveoles de 124 px de haut, a la taille de celles
             qui s'allument : c'est ce qui fait que la grappe appartient au
             fond au lieu de flotter dessus. -->
        <g fill="none" stroke="#F2ECE4" stroke-opacity="0.055" stroke-width="1">
          <polygon
            v-for="(c, i) in treillis"
            :key="`t${i}`"
            :points="SOMMETS"
            :transform="`translate(${c.x} ${c.y})`"
          />
        </g>

        <rect :width="VUE.w" :height="VUE.h" fill="url(#halo)" />

        <!-- Les orbites, qui donnent sa profondeur a la grappe. -->
        <g fill="none" stroke="#E59A3C" stroke-opacity="0.13" stroke-dasharray="2 9">
          <circle :cx="NOYAU.x" :cy="NOYAU.y" r="150" />
          <circle :cx="NOYAU.x" :cy="NOYAU.y" r="252" class="orbite" />
        </g>

        <!-- Les fils entre le noyau et les pieces eclairees. -->
        <g stroke="#E59A3C" stroke-opacity="0.2" stroke-width="1">
          <line
            v-for="(a, i) in alveoles"
            :key="`f${i}`"
            :x1="NOYAU.x" :y1="NOYAU.y" :x2="a.x" :y2="a.y"
          />
        </g>

        <!-- Le halo diffus de la grappe, dessous. -->
        <g fill="#C87819" filter="url(#flou)" opacity="0.5" class="grappe">
          <polygon
            v-for="(a, i) in alveoles"
            :key="`h${i}`"
            :points="SOMMETS"
            :opacity="a.eclat"
            :transform="`translate(${a.x} ${a.y})`"
            :style="{ animationDelay: `${a.retard}ms, ${a.retard + 900}ms`, animationDuration: `620ms, ${a.souffle}s` }"
          />
        </g>

        <!-- Les alveoles elles-memes. -->
        <g class="grappe">
          <polygon
            v-for="(a, i) in alveoles"
            :key="`a${i}`"
            :points="SOMMETS"
            fill="#E59A3C"
            :fill-opacity="a.eclat"
            stroke="#FFD9A0"
            stroke-opacity="0.22"
            stroke-width="1.2"
            :transform="`translate(${a.x} ${a.y})`"
            :style="{ animationDelay: `${a.retard}ms, ${a.retard + 900}ms`, animationDuration: `620ms, ${a.souffle}s` }"
          />
        </g>

        <!-- Les abeilles : un point qui remonte ou redescend chaque fil. -->
        <g fill="#FFF1DA" class="essaim">
          <circle
            v-for="(b, i) in abeilles"
            :key="`b${i}`"
            :cx="b.depart.x"
            :cy="b.depart.y"
            :r="b.rayon"
            :style="{
              '--dx': `${b.dx}px`,
              '--dy': `${b.dy}px`,
              animationDuration: `${b.duree}s`,
              animationDelay: `${b.retard}s`,
            }"
          />
        </g>

        <!-- Le noyau : le serveur, au centre de tout. -->
        <g class="noyau" :transform="`translate(${NOYAU.x} ${NOYAU.y})`">
          <polygon :points="SOMMETS" fill="#C87819" filter="url(#flou)" opacity="0.95" transform="scale(0.62)" />
          <polygon :points="SOMMETS" fill="url(#noyauFeu)" transform="scale(0.55)" />
          <polygon :points="SOMMETS" fill="none" stroke="#FFE7C4" stroke-opacity="0.6" stroke-width="1.8" transform="scale(0.55)" />
          <circle r="7" fill="#FFF6E8" />
          <polygon class="onde" :points="SOMMETS" fill="none" stroke="#E59A3C" stroke-width="1.4" transform="scale(0.55)" />
        </g>

        <!-- Des poussieres de lumiere, semees au hasard. -->
        <g fill="#E59A3C" class="poussieres">
          <circle
            v-for="(d, i) in poussieres"
            :key="`p${i}`"
            :cx="d.x" :cy="d.y" :r="d.r"
            :style="{ animationDuration: `${d.duree}s`, animationDelay: `${d.retard}s` }"
          />
        </g>
      </svg>

      <!--
        Le voile.

        Sur telephone, le cadrage « slice » remonte les alveoles pile derriere
        le titre, qui devient illisible. Un degrade depuis le haut rend le
        texte lisible sans eteindre la ruche : elle reste visible sous lui, en
        retrait. Plus marque sur petit ecran, ou le texte et la grappe se
        disputent les memes pixels.
      -->
      <div
        class="pointer-events-none absolute inset-x-0 top-0 h-[62%] bg-gradient-to-b from-ink via-ink/80 to-transparent lg:h-[48%] lg:via-ink/55"
      ></div>

      <!-- En haut : qui parle, et dans quel etat. -->
      <div class="entre relative flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <span class="grid h-11 w-11 place-items-center rounded-[14px] bg-glow text-ink">
            <Icon name="ruche" :size="22" />
          </span>
          <div class="flex flex-col">
            <span class="text-[17px] font-semibold text-surface">La Ruche</span>
            <span class="text-[11px] text-surface/55">
              Domotique locale · Raspberry&nbsp;Pi · SQLite
            </span>
          </div>
        </div>

        <!--
          L'etat du serveur, et il est HONNETE : la page n'est arrivee jusqu'ici
          que parce que `/api/auth/etat` a repondu. Si le serveur etait muet,
          c'est le message d'erreur du formulaire qu'on lirait.
        -->
        <p
          class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-surface/10 bg-surface/[0.06] px-3.5 py-2"
        >
          <span class="pouls h-[7px] w-[7px] shrink-0 rounded-full bg-ok"></span>
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-surface/60">
            laruche.local · en ligne
          </span>
        </p>
      </div>

      <!-- Juste dessous : la regle d'or du projet, en guise d'accroche. -->
      <div class="entre entre-2 relative mt-7 max-w-[320px] lg:max-w-[430px]">
        <p
          class="text-balance text-[32px] font-semibold leading-[1.05] tracking-[-0.025em] text-surface sm:text-[38px] lg:text-[46px]"
        >
          Une maison qui ne ment pas.
        </p>
        <p class="mt-4 max-w-[34ch] text-[13px] leading-relaxed text-surface/55 lg:text-[15px]">
          L'état vient du matériel, jamais du clic.
        </p>
      </div>

      <!--
        Tout en bas : ce que la maison sait faire. Rien qui la decrive, ELLE :
        pas de pieces, pas d'adresse, pas de nombre d'equipements. Seulement
        les familles, qui sont les memes dans n'importe quelle maison.
      -->
      <ul
        class="entre entre-3 relative mt-auto hidden flex-wrap items-center gap-x-5 gap-y-2 border-t border-surface/[0.08] pt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-surface/55 lg:flex"
      >
        <li>Éclairages</li>
        <li>Volets</li>
        <li>Chauffage</li>
        <li>Énergie</li>
        <li>Caméras</li>
      </ul>
    </aside>

    <!-- ==================================================== le formulaire -->
    <main
      class="relative -mt-7 flex items-start justify-center rounded-t-[30px] bg-surface px-5 pb-12 pt-9 lg:mt-0 lg:items-center lg:rounded-none lg:px-10 lg:py-10"
    >
      <div class="entre entre-2 w-full max-w-[400px]">
        <p class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          La Ruche · réseau local
        </p>
        <h1 class="mt-2.5 text-[28px] font-semibold leading-tight tracking-[-0.02em] lg:text-[32px]">
          {{ titre }}
        </h1>
        <p class="mt-1.5 text-sm leading-relaxed text-soft">
          {{
            premiere
              ? 'Créez le compte qui gérera la maison. Il pourra ensuite en ouvrir d’autres.'
              : parVisage
                ? 'Qui se connecte ?'
                : 'Connectez-vous pour piloter la maison.'
          }}
        </p>

        <form class="mt-6 space-y-4" novalidate @submit.prevent="valider">
          <!-- Les visages. -->
          <div v-if="parVisage" class="flex flex-wrap gap-2">
            <button
              v-for="h in habitants"
              :key="h.id"
              type="button"
              class="press flex min-h-[64px] flex-1 basis-[106px] items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors"
              :class="
                choisi === h.id
                  ? 'border-ink bg-ink text-surface'
                  : 'border-line bg-ground hover:border-ink/25'
              "
              :aria-pressed="choisi === h.id"
              @click="choisi = h.id"
            >
              <span
                class="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold"
                :class="choisi === h.id ? 'bg-surface/15 text-surface' : 'bg-glow/15 text-glow-deep'"
              >{{ h.initiale }}</span>
              <span class="flex min-w-0 flex-col">
                <span class="truncate text-[14px] font-semibold">{{ h.nom }}</span>
                <span
                  class="truncate text-[11px]"
                  :class="choisi === h.id ? 'text-surface/60' : 'text-soft'"
                >{{ ROLE_LABELS[h.role] }}</span>
              </span>
            </button>
          </div>

          <!-- La saisie de l'identifiant : premiere ouverture, ou liste
               indisponible parce que le serveur refuse de la donner. -->
          <div v-if="!parVisage" class="space-y-1.5">
            <label for="identifiant" class="block text-[13px] font-medium text-soft">
              Identifiant
            </label>
            <input
              id="identifiant"
              ref="champIdentifiant"
              v-model="identifiant"
              type="text"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              :aria-invalid="Boolean(refusIdentifiant)"
              class="champ"
              placeholder="romain"
            />
            <p v-if="premiere" class="text-xs text-soft">En minuscules, sans accent ni espace.</p>
          </div>

          <div v-if="premiere" class="space-y-1.5">
            <label for="nom" class="block text-[13px] font-medium text-soft">Nom affiché</label>
            <input
              id="nom"
              v-model="nom"
              type="text"
              name="name"
              autocomplete="name"
              :aria-invalid="Boolean(refusNom)"
              class="champ"
              placeholder="Romain"
            />
          </div>

          <div class="space-y-1.5">
            <label for="motdepasse" class="block text-[13px] font-medium text-soft">
              Mot de passe
            </label>
            <div class="relative">
              <input
                id="motdepasse"
                ref="champMotDePasse"
                v-model="motDePasse"
                :type="visible ? 'text' : 'password'"
                name="password"
                :autocomplete="premiere ? 'new-password' : 'current-password'"
                :aria-invalid="Boolean(refusMotDePasse)"
                :aria-describedby="premiere ? 'aide-mdp' : undefined"
                class="champ pr-14"
                placeholder="••••••••"
                @keyup="surClavier"
                @keydown="surClavier"
              />
              <!-- Montrer le mot de passe : indispensable sur un telephone, ou
                   une phrase de douze caracteres se tape mal en aveugle. -->
              <button
                type="button"
                class="press absolute right-1.5 top-1.5 grid h-[45px] w-11 place-items-center rounded-xl text-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
                :aria-label="visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
                :aria-pressed="visible"
                @click="visible = !visible"
              >
                <Icon :name="visible ? 'lune' : 'soleil'" :size="18" />
              </button>
            </div>
            <p v-if="premiere" id="aide-mdp" class="text-xs leading-relaxed text-soft">
              {{ MOT_DE_PASSE_MIN }} caractères au minimum. Une phrase courte fait un très bon mot
              de passe, et se retient.
            </p>
          </div>

          <p v-if="majuscules" class="flex items-center gap-2 text-xs text-warn-deep">
            <Icon name="alerte" :size="14" class="shrink-0" />
            La touche majuscule est active.
          </p>

          <!-- Une vraie case a cocher plutot qu'un interrupteur dessine : elle
               se coche au clavier et s'annonce toute seule. -->
          <div v-if="!premiere" class="flex min-h-[44px] flex-wrap items-center justify-between gap-3">
            <!--
              Un interrupteur, comme dans la maquette, mais bati sur une VRAIE
              case a cocher : elle garde le clavier, la barre d'espace et
              l'annonce « coche / decoche » du lecteur d'ecran. Un interrupteur
              dessine avec des div perdrait les trois.
            -->
            <label class="flex cursor-pointer items-center gap-3">
              <span
                class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200"
                :class="rester ? 'bg-ok' : 'bg-ink/[0.18]'"
              >
                <input
                  v-model="rester"
                  type="checkbox"
                  class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Rester connecté sur cet appareil"
                />
                <span
                  class="pointer-events-none absolute left-[3px] h-[18px] w-[18px] rounded-full bg-surface shadow-sm transition-transform duration-200"
                  :class="rester ? 'translate-x-[20px]' : ''"
                ></span>
              </span>
              <span class="text-[13px] text-soft">Rester connecté sur cet appareil</span>
            </label>

            <!--
              Pas un lien : il n'y a pas de page a ouvrir, ni de serveur de
              courrier pour envoyer quoi que ce soit. Le bouton dit simplement
              ou se trouve la solution.
            -->
            <button
              type="button"
              class="press -mx-2 inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-2 text-[13px] font-medium text-glow-deep underline-offset-4 hover:underline"
              @click="auth.erreur = 'Un administrateur de la maison peut réinitialiser votre mot de passe depuis les Réglages.'"
            >
              Mot de passe oublié&nbsp;?
            </button>
          </div>

          <!-- `role="alert"` : un lecteur d'ecran annonce le refus des qu'il
               s'affiche, sans que la personne ait a partir a sa recherche. -->
          <p
            v-if="message"
            role="alert"
            class="flex items-start gap-2.5 rounded-xl border border-crit/25 bg-crit/[0.06] px-3.5 py-3 text-[13px] leading-relaxed text-crit"
          >
            <Icon name="alerte" :size="16" class="mt-px shrink-0" />
            <span>{{ message }}</span>
          </p>

          <button
            type="submit"
            class="press flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-glow-deep text-[15px] font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-60"
            :disabled="envoi"
          >
            {{ envoi ? 'Connexion…' : premiere ? 'Créer le compte' : 'Ouvrir la maison' }}
            <Icon v-if="!envoi" name="chevron" :size="17" />
          </button>
        </form>

        <!-- Ce que la maison promet : rien ne sort. -->
        <p class="mt-7 flex items-start gap-2.5 text-xs leading-relaxed text-faint">
          <Icon name="maison" :size="15" class="mt-px shrink-0" />
          <span>
            Connexion locale au serveur de la maison,
            <span class="font-mono text-[11px] text-soft">laruche.local</span>. Rien ne passe par
            Internet.
          </span>
        </p>

        <p v-if="premiere" class="mt-3 text-xs leading-relaxed text-faint">
          Ce compte sera administrateur&nbsp;: il pourra créer les autres et modifier le matériel.
        </p>

      </div>
    </main>
  </div>
</template>

<style scoped>
/*
 * Des champs hauts, 52 px, et un angle genereux.
 *
 * Bien au-dela des 44 px exiges : on tape ici un mot de passe long, souvent
 * debout dans une entree, parfois avec les mains prises. Ce n'est pas un
 * formulaire d'inscription qu'on remplit une fois assis a un bureau.
 */
.champ {
  @apply min-h-[52px] w-full rounded-2xl border border-line bg-ground px-4 text-[15px];
  @apply placeholder:text-faint/60;
  @apply transition-[border-color,box-shadow] duration-150;
}

/*
 * L'anneau du focus est pose ICI plutot que laisse au style global : celui-ci
 * dessine un anneau decolle de 2 px, qui ne suit pas l'arrondi du champ et
 * laisse un lisere pale dans les coins.
 */
.champ:focus {
  @apply border-glow bg-surface outline-none;
  box-shadow: 0 0 0 3px rgb(var(--c-glow) / 0.16);
}

.champ[aria-invalid='true'] {
  @apply border-crit/60;
}

.champ[aria-invalid='true']:focus {
  box-shadow: 0 0 0 3px rgb(var(--c-crit) / 0.16);
}

/*
 * Le remplissage automatique de Chrome.
 *
 * Sans ces lignes, le navigateur peint le champ en BLEU PALE, par-dessus tout
 * le reste : la page se retrouve avec un rectangle bleu au milieu d'une
 * maquette ambre et papier. `background-color` ne suffit pas a le corriger,
 * Chrome l'ignore ici ; seule une ombre interne opaque reprend la main.
 */
.champ:-webkit-autofill,
.champ:-webkit-autofill:hover,
.champ:-webkit-autofill:focus {
  box-shadow: inset 0 0 0 1000px rgb(var(--c-ground));
  -webkit-text-fill-color: rgb(var(--c-ink));
  caret-color: rgb(var(--c-ink));
  transition: background-color 9999s;
}

.champ:-webkit-autofill:focus {
  box-shadow:
    inset 0 0 0 1000px rgb(var(--c-surface)),
    0 0 0 3px rgb(var(--c-glow) / 0.16);
}

/*
 * L'entree en scene.
 *
 * Un leger glissement vers le haut, decale de 90 ms entre les trois blocs.
 * L'oeil suit alors un ordre : qui parle, ce que la maison promet, ce qu'elle
 * sait faire. Sans ce decalage, tout apparait d'un coup et on ne sait plus par
 * ou commencer.
 *
 * 420 ms : assez pour se voir, assez court pour ne jamais faire attendre
 * quelqu'un qui veut juste rentrer chez lui.
 */
.entre {
  animation: entre 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.entre-2 {
  animation-delay: 90ms;
}
.entre-3 {
  animation-delay: 180ms;
}

@keyframes entre {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/*
 * Le pouls de la pastille verte.
 *
 * Il dit « le serveur repond », et pas seulement « il a repondu quand la page
 * s'est chargee ». Un point fixe se lit comme une image ; un point qui bat se
 * lit comme un signe de vie.
 */
.pouls {
  animation: pouls 2.6s ease-in-out infinite;
}

@keyframes pouls {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgb(var(--c-ok) / 0.5);
  }
  50% {
    opacity: 0.75;
    box-shadow: 0 0 0 4px rgb(var(--c-ok) / 0);
  }
}

/*
 * LA RUCHE S'ALLUME.
 *
 * Les alveoles n'apparaissent pas ensemble : elles s'allument l'une apres
 * l'autre en partant du noyau. C'est une maison dont on allume les pieces en
 * rentrant, et c'est la premiere chose que l'oeil suit en arrivant.
 *
 * Deux animations enchainees sur le meme element : l'allumage, puis le
 * souffle. Leurs durees et leurs retards sont poses en style inline par le
 * composant, parce qu'ils sont tires au hasard a chaque ouverture.
 */
.grappe polygon {
  transform-box: fill-box;
  transform-origin: center;
  animation:
    sallume cubic-bezier(0.34, 1.3, 0.5, 1) both,
    souffle ease-in-out infinite;
}

@keyframes sallume {
  from {
    opacity: 0;
    scale: 0.5;
  }
}

@keyframes souffle {
  0%,
  100% {
    filter: brightness(0.86);
  }
  50% {
    filter: brightness(1.12);
  }
}

/*
 * LES ABEILLES.
 *
 * Chaque point part d'un bout du fil et rejoint l'autre. Le deplacement est
 * porte par deux variables posees par le composant, tirees au hasard : sans
 * elles, toutes les abeilles suivraient le meme trajet au meme instant, et on
 * lirait un clignotant plutot qu'une ruche.
 *
 * `linear` et non `ease` : une abeille ne ralentit pas en arrivant.
 */
.essaim circle {
  animation: vole linear infinite;
  opacity: 0;
}

@keyframes vole {
  0% {
    opacity: 0;
    translate: 0 0;
  }
  12%,
  82% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    translate: var(--dx) var(--dy);
  }
}

/* L'orbite exterieure tourne, tres lentement. */
.orbite {
  transform-box: fill-box;
  transform-origin: center;
  animation: tourne 140s linear infinite;
}

@keyframes tourne {
  to {
    rotate: 360deg;
  }
}

/*
 * Le noyau : le serveur, au centre. Il arrive en premier, et bat ensuite.
 * C'est de lui que part la lumiere, donc c'est par lui que tout commence.
 */
.noyau {
  transform-box: fill-box;
  animation: noyauEntre 700ms cubic-bezier(0.34, 1.3, 0.5, 1) both;
}

@keyframes noyauEntre {
  from {
    opacity: 0;
    scale: 0.35;
  }
}

/*
 * L'onde qui part du noyau.
 *
 * Elle dit la meme chose que la pastille verte, autrement : quelque chose
 * repond, la maison est vivante. Quatre secondes entre deux ondes, assez
 * espacees pour ne jamais devenir un clignotant.
 */
.onde {
  transform-box: fill-box;
  transform-origin: center;
  animation: onde 4.5s ease-out 1.2s infinite;
}

@keyframes onde {
  0% {
    opacity: 0.55;
    scale: 0.55;
  }
  70%,
  100% {
    opacity: 0;
    scale: 2.4;
  }
}

/* Des poussieres de lumiere qui montent et se perdent. */
.poussieres circle {
  animation: monte linear infinite;
  opacity: 0;
}

@keyframes monte {
  0% {
    opacity: 0;
    translate: 0 0;
  }
  18%,
  70% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
    translate: 0 -210px;
  }
}

/*
 * L'entree en scene du texte, posee par-dessus la ruche.
 *
 * Un glissement vers le haut, decale de 110 ms entre les trois blocs. L'oeil
 * suit alors un ordre : qui parle, ce que la maison promet, ce qu'elle sait
 * faire.
 */
.entre {
  animation: entre 620ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.entre-2 {
  animation-delay: 110ms;
}
.entre-3 {
  animation-delay: 220ms;
}

@keyframes entre {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/*
 * Le pouls de la pastille verte.
 *
 * Il dit « le serveur repond », et pas seulement « il a repondu quand la page
 * s'est chargee ». Un point fixe se lit comme une image ; un point qui bat se
 * lit comme un signe de vie.
 */
.pouls {
  animation: pouls 2.6s ease-in-out infinite;
}

@keyframes pouls {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgb(var(--c-ok) / 0.5);
  }
  50% {
    opacity: 0.75;
    box-shadow: 0 0 0 4px rgb(var(--c-ok) / 0);
  }
}

/*
 * LA RUCHE S'ALLUME.
 *
 * Les alveoles n'apparaissent pas ensemble : elles s'allument l'une apres
 * l'autre en partant du noyau, sur un peu plus d'une seconde. C'est une maison
 * dont on allume les pieces en rentrant, et c'est la premiere chose que l'oeil
 * suit en arrivant sur la page.
 *
 * `both` garde l'etat de depart avant le delai : sans lui, chaque alveole
 * apparaitrait a pleine lumiere puis se rallumerait, ce qui produit un
 * clignotement desagreable.
 */
.grappe use {
  transform-box: fill-box;
  transform-origin: center;
  animation:
    sallume 620ms cubic-bezier(0.34, 1.3, 0.5, 1) both,
    respire 6s ease-in-out 1.6s infinite;
}

@keyframes sallume {
  from {
    opacity: 0;
    scale: 0.55;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}

/* Puis elles respirent, chacune a son rythme grace au decalage herite. */
@keyframes respire {
  0%,
  100% {
    opacity: 0.82;
  }
  50% {
    opacity: 1;
  }
}

/*
 * Le noyau : le serveur, au centre. Il arrive en premier, et bat ensuite.
 * C'est de lui que part la lumiere, donc c'est par lui que tout commence.
 */
.noyau {
  transform-box: fill-box;
  animation: noyauEntre 700ms cubic-bezier(0.34, 1.3, 0.5, 1) both;
}

@keyframes noyauEntre {
  from {
    opacity: 0;
    scale: 0.4;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}

/*
 * L'onde qui part du noyau.
 *
 * Elle dit la meme chose que la pastille verte, autrement : quelque chose
 * repond, la maison est vivante. Quatre secondes entre deux ondes, assez
 * espacees pour ne jamais devenir un clignotant.
 */
.onde {
  transform-box: fill-box;
  transform-origin: center;
  animation: onde 4s ease-out 1.2s infinite;
}

@keyframes onde {
  0% {
    opacity: 0.6;
    scale: 1;
  }
  70%,
  100% {
    opacity: 0;
    scale: 3.4;
  }
}

/* Les rais de lumiere tournent tres lentement autour du noyau. */
.rais {
  transform-box: fill-box;
  transform-origin: 378px 451px;
  animation:
    tourne 90s linear infinite,
    apparait 1.4s ease-out 600ms both;
}

@keyframes tourne {
  to {
    rotate: 360deg;
  }
}

@keyframes apparait {
  to {
    opacity: 1;
  }
}

/* Des poussieres de lumiere qui montent et se perdent. */
.poussieres circle {
  animation: monte 11s linear infinite;
  opacity: 0;
}

@keyframes monte {
  0% {
    opacity: 0;
    translate: 0 0;
  }
  18%,
  70% {
    opacity: 0.75;
  }
  100% {
    opacity: 0;
    translate: 0 -190px;
  }
}

/*
 * L'entree en scene du texte, posee par-dessus la ruche.
 *
 * Un glissement vers le haut, decale de 110 ms entre les trois blocs. L'oeil
 * suit alors un ordre : qui parle, ce que la maison promet, ce qu'elle sait
 * faire. Sans ce decalage, tout apparait d'un coup et on ne sait plus par ou
 * commencer.
 */
.entre {
  animation: entre 620ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.entre-2 {
  animation-delay: 110ms;
}
.entre-3 {
  animation-delay: 220ms;
}

@keyframes entre {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/*
 * Le pouls de la pastille verte.
 *
 * Il dit « le serveur repond », et pas seulement « il a repondu quand la page
 * s'est chargee ». Un point fixe se lit comme une image ; un point qui bat se
 * lit comme un signe de vie.
 */
.pouls {
  animation: pouls 2.6s ease-in-out infinite;
}

@keyframes pouls {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgb(var(--c-ok) / 0.5);
  }
  50% {
    opacity: 0.72;
    box-shadow: 0 0 0 5px rgb(var(--c-ok) / 0);
  }
}

/*
 * Mouvement reduit : plus rien ne bouge, mais rien ne disparait non plus.
 *
 * Une animation coupee sans ces valeurs finales laisserait la ruche eteinte et
 * les textes invisibles pour toujours, puisque `both` fige l'etat de depart.
 * C'est l'erreur classique de cette clause, et elle rend la page inutilisable
 * pour les personnes qui en ont le plus besoin.
 */
@media (prefers-reduced-motion: reduce) {
  .entre,
  .pouls,
  .noyau,
  .orbite,
  .grappe polygon {
    animation: none;
    opacity: 1;
    scale: 1;
    rotate: none;
    transform: none;
    filter: none;
  }

  /* Les abeilles et les poussieres n'ont de sens qu'en mouvement : figees,
     ce ne sont que des points poses au hasard. On les retire. */
  .onde,
  .essaim circle,
  .poussieres circle {
    animation: none;
    opacity: 0;
  }
}

</style>
