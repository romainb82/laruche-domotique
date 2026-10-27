import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { auMoins, type Compte, type Role } from '@domo/shared';

/**
 * Un habitant tel que la page de connexion a le droit de le voir : un prenom
 * et un role. Jamais l'identifiant de connexion : on choisit un visage, on ne
 * recupere pas de quoi commencer a deviner.
 */
export interface Habitant {
  id: string;
  nom: string;
  initiale: string;
  role: Role;
}

/**
 * Qui est connecté.
 *
 * Le jeton de session n'apparaît nulle part ici, et c'est voulu : il vit dans
 * un cookie `HttpOnly` que JavaScript ne peut pas lire. Une faille d'injection
 * dans l'interface ne permettrait donc pas de le voler, alors qu'un jeton
 * rangé dans `localStorage` serait lisible par n'importe quel script de la
 * page.
 *
 * Conséquence assumée : on ne sait jamais « de tête » si on est connecté, il
 * faut le demander au serveur. C'est le rôle de `verifier()`.
 */
export const useAuth = defineStore('auth', () => {
  /** `null` = personne. Tant que `pret` est faux, on ne sait simplement pas encore. */
  const compte = ref<Compte | null>(null);
  /** Faux tant qu'aucun compte n'existe : la maison demandera d'en créer un. */
  const installe = ref(true);
  const pret = ref(false);
  const erreur = ref<string | null>(null);

  const connecte = computed(() => compte.value !== null);

  /** Pour masquer ce qu'un rôle n'a pas le droit de faire, côté interface. */
  const peut = (minimum: Role) => (compte.value ? auMoins(compte.value.role, minimum) : false);

  async function verifier(): Promise<void> {
    try {
      const r = await fetch('/api/auth/etat');
      const d = await r.json();
      installe.value = Boolean(d.installe);
      compte.value = (d.compte as Compte | null) ?? null;
    } catch {
      // Serveur injoignable : on ne prétend pas que la personne est connectée.
      // Le bandeau de lien, lui, dira que la maison ne répond pas.
      compte.value = null;
    } finally {
      pret.value = true;
    }
  }

  /** Message d'erreur du serveur, ou `null` si tout s'est bien passé. */
  async function envoyer(url: string, corps: unknown): Promise<string | null> {
    erreur.value = null;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        erreur.value = d.error ?? 'La connexion a échoué.';
        return erreur.value;
      }
      compte.value = (d.compte as Compte) ?? null;
      installe.value = true;
      return null;
    } catch {
      erreur.value = 'La maison ne répond pas. Vérifiez que le serveur tourne.';
      return erreur.value;
    }
  }

  /**
   * Qui habite ici, pour que la page propose des visages plutot qu'un champ
   * vide. Le serveur peut refuser de repondre (`HABITANTS=off`) : la liste est
   * alors vide, et la page retombe sur la saisie de l'identifiant.
   */
  const habitants = ref<Habitant[]>([]);

  async function chargerHabitants(): Promise<void> {
    try {
      const r = await fetch('/api/auth/habitants');
      habitants.value = ((await r.json())?.habitants ?? []) as Habitant[];
    } catch {
      habitants.value = [];
    }
  }

  const connexion = (identifiant: string, motDePasse: string, rester = true) =>
    envoyer('/api/auth/login', { identifiant, motDePasse, rester });

  /** Connexion apres avoir choisi son visage dans la liste. */
  const connexionParId = (compteId: string, motDePasse: string, rester = true) =>
    envoyer('/api/auth/login', { compteId, motDePasse, rester });

  const premierCompte = (identifiant: string, nom: string, motDePasse: string) =>
    envoyer('/api/auth/premier-compte', { identifiant, nom, motDePasse });

  async function deconnexion(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Même si l'appel échoue, on oublie la personne localement : sinon
      // l'interface continuerait d'afficher une session qui n'existe plus.
      compte.value = null;
    }
  }

  /**
   * Appelé quand une requête quelconque revient en 401.
   *
   * C'est ce qui ramène à la page de connexion lorsque la session a expiré
   * pendant la nuit, sans attendre que la personne clique quelque part.
   */
  function expiree(): void {
    compte.value = null;
  }

  return {
    compte,
    habitants,
    chargerHabitants,
    connexionParId,
    installe,
    pret,
    erreur,
    connecte,
    peut,
    verifier,
    connexion,
    premierCompte,
    deconnexion,
    expiree,
  };
});
