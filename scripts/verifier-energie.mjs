/**
 * Le calcul de consommation, mis a l'epreuve.
 *
 * On ne mesure pas des kilowattheures : on mesure une puissance, a intervalles
 * irreguliers, et l'energie s'en deduit. Trois erreurs classiques sont
 * verifiees ici, parce qu'aucune ne se voit a l'oeil sur un graphique :
 *
 *   · combler un trou d'historique et inventer la consommation d'une coupure ;
 *   · comparer huit heures d'aujourd'hui aux vingt-quatre heures d'hier ;
 *   · decouper une journee de changement d'heure en vingt-quatre heures alors
 *     qu'elle en fait vingt-trois.
 */
import {
  bornesPeriode, integrer, repartir, pic, TROU_MAX_MS,
} from '../packages/shared/dist/index.js';

import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
await ouvrirSession();

const B = 'http://localhost:3001';
const TZ = 'Europe/Paris';
const H = 3_600_000;

const j = async (u) => { const r = await fetch(B + u); return [r.status, await r.json().catch(() => null)]; };
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const proche = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ======================================================= l'integration

// Les mesures arrivent a la minute : plus espacees que TROU_MAX_MS, elles
// seraient ecartees : a juste titre, mais ce n'est pas ce qu'on teste ici.
const t0 = Date.parse('2026-09-10T00:00:00Z');
const echantillons = (n, f) =>
  Array.from({ length: n + 1 }, (_, i) => ({ at: t0 + i * 60_000, value: f(i / n) }));

// 1000 W pendant une heure = 1 kWh. Le cas le plus simple doit etre exact.
const plat = echantillons(60, () => 1000);
ok(proche(integrer(plat, t0, t0 + H).kwh, 1, 1e-9),
   `1000 W pendant 1 h = ${integrer(plat, t0, t0 + H).kwh} kWh`);

// Une rampe de 0 a 1000 W vaut la moitie : c'est la regle du trapeze.
const rampe = echantillons(60, (x) => x * 1000);
ok(proche(integrer(rampe, t0, t0 + H).kwh, 0.5, 1e-9),
   `Rampe de 0 à 1000 W sur 1 h = ${integrer(rampe, t0, t0 + H).kwh} kWh, soit la moitié`);

// Les bornes decoupent : une demi-heure au milieu ne vaut que sa part.
ok(proche(integrer(plat, t0 + H / 4, t0 + (3 * H) / 4).kwh, 0.5),
   'Une fenêtre plus étroite ne compte que sa part');

// --- LE TROU : une coupure ne se comble pas ---
const trou = [
  { at: t0, value: 1000 },
  { at: t0 + 60_000, value: 1000 },          // une minute mesurée
  { at: t0 + 24 * H, value: 1000 },          // puis 24 h de silence
  { at: t0 + 24 * H + 60_000, value: 1000 }, // et une minute de retour
];
const r = integrer(trou, t0, t0 + 25 * H);
ok(proche(r.kwh, 2 / 60, 1e-9),
   `24 h de silence ne produisent aucune consommation : ${r.kwh.toFixed(4)} kWh pour 2 minutes mesurées`);
ok(r.mesureMs === 120_000,
   `Et le temps réellement mesuré est annoncé : ${r.mesureMs / 1000} s`);
ok(TROU_MAX_MS === 900_000, `Le seuil de trou vaut ${TROU_MAX_MS / 60_000} min`);

// ======================================================= les bornes

// --- COMPARAISON A DUREE EGALE : le piege du « −95 % » ---
const matin = new Date('2026-09-10T06:00:00Z'); // 08:00 à Paris
const bJour = bornesPeriode('jour', matin, TZ);
const ecouleCourant = matin.getTime() - bJour.debut;
const ecoulePrecedent = bJour.precedentFin - bJour.precedentDebut;
ok(ecouleCourant === ecoulePrecedent,
   `À 8 h du matin, on se compare aux 8 premières heures d'hier (${ecouleCourant / H} h contre ${ecoulePrecedent / H} h)`);
ok(bJour.precedentFin - bJour.precedentDebut < 24 * H,
   'Et surtout pas à la journée entière d’hier');
ok(/même heure/.test(bJour.comparaison), `Ce que la phrase annonce : « ${bJour.comparaison} »`);

// --- LE CHANGEMENT D'HEURE : une journee de 23 heures ---
const printemps = new Date('2026-03-29T12:00:00Z');
const bPrintemps = bornesPeriode('jour', printemps, TZ);
ok((bPrintemps.fin - bPrintemps.debut) / H === 23,
   `Le 29 mars dure ${(bPrintemps.fin - bPrintemps.debut) / H} heures, pas 24`);

const automne = new Date('2026-10-25T12:00:00Z');
const bAutomne = bornesPeriode('jour', automne, TZ);
ok((bAutomne.fin - bAutomne.debut) / H === 25,
   `Et le 25 octobre en dure ${(bAutomne.fin - bAutomne.debut) / H}`);

// Les seaux suivent : 23 seaux le jour du passage a l'heure d'ete.
const seauxPrintemps = repartir([], 'jour', bPrintemps, TZ, printemps.getTime());
ok(seauxPrintemps.length === 23,
   `Ce jour-là l'histogramme a ${seauxPrintemps.length} barres, pas 24`);
const seauxAutomne = repartir([], 'jour', bAutomne, TZ, automne.getTime());
ok(seauxAutomne.length === 25,
   `Et ${seauxAutomne.length} le jour du retour à l'heure d'hiver`);

// --- SEMAINE ET MOIS ---
const bSemaine = bornesPeriode('semaine', matin, TZ);
ok(repartir([], 'semaine', bSemaine, TZ, matin.getTime()).length === 7,
   'Une semaine fait 7 barres');
const bMois = bornesPeriode('mois', matin, TZ);
const seauxMois = repartir([], 'mois', bMois, TZ, matin.getTime());
ok(seauxMois.length === 10, `Le 10 septembre, le mois en cours a ${seauxMois.length} barres`);

// --- LE PIC ignore ce qui n'est pas encore arrive ---
const avecFutur = [
  { at: 0, label: '0h', kwh: 1, futur: false },
  { at: 1, label: '1h', kwh: 5, futur: true },
  { at: 2, label: '2h', kwh: 2, futur: false },
];
ok(pic(avecFutur)?.label === '2h',
   `Le pic est le plus fort des seaux PASSÉS : ${pic(avecFutur)?.label}`);
ok(pic([]) === null, 'Aucune mesure : aucun pic, plutôt qu’un zéro trompeur');

// ======================================================= la route

const [code, bilan] = await j('/api/energy?period=jour');
ok(code === 200 && bilan?.meter?.id, `Compteur désigné : ${bilan?.meter?.label ?? 'aucun'}`);
ok(typeof bilan?.kwh === 'number' && bilan.kwh >= 0, `Total du jour : ${bilan?.kwh} kWh`);
ok(bilan?.seaux?.length === 23 || bilan?.seaux?.length === 24 || bilan?.seaux?.length === 25,
   `${bilan?.seaux?.length} barres pour la journée`);
ok(bilan?.couverture >= 0 && bilan?.couverture <= 1,
   `Couverture annoncée : ${Math.round((bilan?.couverture ?? 0) * 100)} % de la période mesurée`);

// --- LE TARIF : pas de tarif, pas de montant ---
const [, cfg] = await j('/api/config');
ok(cfg?.energy !== undefined, 'La configuration porte une section énergie');
if ((cfg?.energy?.pricePerKwh ?? 0) === 0)
  ok(bilan?.cout === null, 'Sans tarif saisi, aucun montant n’est affiché plutôt qu’un montant inventé');
else
  ok(typeof bilan?.cout === 'number', `Avec un tarif, le coût est calculé : ${bilan?.cout} €`);

// --- LES TROIS PERIODES repondent ---
for (const p of ['semaine', 'mois']) {
  const [c, b] = await j(`/api/energy?period=${p}`);
  ok(c === 200 && b?.period === p && Array.isArray(b?.seaux),
     `Période « ${p} » : ${b?.seaux?.length} barres, ${b?.kwh} kWh, ${b?.comparaison}`);
}

// --- UNE PERIODE INCONNUE retombe sur le jour, sans erreur ---
const [cx, bx] = await j('/api/energy?period=siecle');
ok(cx === 200 && bx?.period === 'jour', 'Une période inconnue retombe sur le jour');

process.exit(process.exitCode ?? 0);
