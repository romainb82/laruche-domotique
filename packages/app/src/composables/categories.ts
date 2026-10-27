/**
 * Les quatre familles de l'accueil.
 *
 * Elles ne remplacent pas les pièces : une pièce répond à « qu'est-ce qui se
 * passe ici », une famille à « où en est le chauffage ». Les deux questions
 * sont vraies, et on ne pouvait répondre qu'à la première.
 *
 * La classification est faite ICI et nulle part ailleurs : le rail et le
 * panneau latéral doivent compter les mêmes équipements, sinon le rail
 * annonce six volets et le panneau en montre sept.
 */
import { findCap, type DeviceConfig } from '@domo/shared';

export type CategorieId = 'lights' | 'covers' | 'climate' | 'contacts';

export interface Categorie {
  id: CategorieId;
  nom: string;
  icone: 'ampoule' | 'volet' | 'thermo' | 'porte';
  /** Laquelle des deux teintes de l'identité porte l'état actif. */
  teinte: 'glow' | 'jour';
}

export const CATEGORIES: readonly Categorie[] = [
  { id: 'lights', nom: 'Éclairage', icone: 'ampoule', teinte: 'glow' },
  { id: 'covers', nom: 'Volets', icone: 'volet', teinte: 'jour' },
  { id: 'climate', nom: 'Climat', icone: 'thermo', teinte: 'glow' },
  { id: 'contacts', nom: 'Ouvrants', icone: 'porte', teinte: 'jour' },
];

/** À quelle famille appartient un équipement. */
export function appartient(d: DeviceConfig, id: CategorieId): boolean {
  switch (id) {
    case 'lights':
      return d.type === 'light' || d.type === 'dimmer';
    case 'covers':
      return d.type === 'cover';
    case 'climate':
      return (
        d.type === 'thermostat' ||
        (d.type === 'sensor' && (d.metric === 'temperature' || d.metric === 'humidity'))
      );
    case 'contacts':
      // Il n'y a pas de métrique `leak` : le détecteur de fuite de la
      // buanderie est un capteur de contact, comme les portes et les fenêtres.
      return d.type === 'sensor' && d.metric === 'contact';
  }
}

export interface Resume {
  /** Ce que le rail écrit sous le nom de la famille. */
  label: string;
  /**
   * Vrai quand quelque chose demande l'attention ou consomme : une lampe
   * allumée, un volet entrouvert, un ouvrant ouvert. C'est ce qui colore
   * l'icône. Le climat n'est jamais « chaud » : une température n'est pas un
   * état qu'on aurait laissé traîner.
   */
  actif: boolean;
}

type LireEtat = (id: string) => ReturnType<typeof etatVide>;
const etatVide = () => undefined as undefined | { health: string; capabilities: unknown[] };

/**
 * Le résumé d'une famille, en une ligne.
 *
 * @param etat  le lecteur d'état du store ; on l'injecte plutôt que d'importer
 *              le store, pour que ce module reste testable sans Pinia.
 */
export function resumer(
  id: CategorieId,
  equipements: DeviceConfig[],
  etat: LireEtat,
): Resume {
  const lus = equipements.map((d) => ({ d, st: etat(d.id) }));
  const joignable = lus.filter((x) => x.st?.health === 'online');

  if (id === 'lights') {
    const allumes = joignable.filter(
      (x) => findCap(x.st as never, 'switch')?.state === true,
    ).length;
    return {
      label: allumes ? `${allumes} allumé${allumes > 1 ? 's' : ''}` : 'tout éteint',
      actif: allumes > 0,
    };
  }

  if (id === 'covers') {
    const positions = joignable.map((x) => findCap(x.st as never, 'cover'));
    const bougent = positions.filter((c) => c?.moving).length;
    // Au-dessus de 5 % on considère le volet ouvert : les moteurs ne rendent
    // pas toujours un zéro franc une fois en butée basse.
    const ouverts = positions.filter((c) => c && c.position > 5).length;
    if (bougent) return { label: `${bougent} en mouvement`, actif: true };
    return {
      label: ouverts ? `${ouverts} ouvert${ouverts > 1 ? 's' : ''}` : 'tous fermés',
      actif: ouverts > 0,
    };
  }

  if (id === 'climate') {
    const temperatures = joignable
      .filter((x) => x.d.metric === 'temperature')
      .map((x) => findCap(x.st as never, 'sensor')?.value)
      .filter((v): v is number => typeof v === 'number');
    if (!temperatures.length) return { label: 'aucune mesure', actif: false };
    const moyenne = temperatures.reduce((a, b) => a + b, 0) / temperatures.length;
    return { label: `${moyenne.toFixed(1).replace('.', ',')} ° en moyenne`, actif: false };
  }

  const ouverts = joignable.filter((x) => findCap(x.st as never, 'sensor')?.value).length;
  return {
    label: ouverts ? `${ouverts} ouvert${ouverts > 1 ? 's' : ''}` : 'tout fermé',
    actif: ouverts > 0,
  };
}
