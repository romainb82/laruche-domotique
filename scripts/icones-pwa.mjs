#!/usr/bin/env node
/**
 * Génère les icônes PNG de la PWA depuis la géométrie de la ruche.
 *
 * Pourquoi écrire un encodeur PNG à la main plutôt qu'installer `sharp` ou
 * `rsvg-convert` : les icônes changent une fois par an, et aucune dépendance
 * n'est nécessaire : Node sait déjà compresser (zlib), et un PNG n'est qu'un
 * en-tête, des lignes de pixels compressées et une somme de contrôle.
 *
 * La géométrie est celle du favicon SVG de `packages/app/index.html`. Les deux
 * doivent rester d'accord : si le dessin change là-bas, il change ici.
 *
 *   node scripts/icones-pwa.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ le PNG */

const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloc(type, data) {
  const taille = Buffer.alloc(4);
  taille.writeUInt32BE(data.length);
  const corps = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const somme = Buffer.alloc(4);
  somme.writeUInt32BE(crc32(corps));
  return Buffer.concat([taille, corps, somme]);
}

/** Encode une image RVBA en PNG, sans filtrage (type 0) : la compression zlib
 *  suffit largement pour des aplats de couleur. */
function encoderPng(cote, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cote, 0);
  ihdr.writeUInt32BE(cote, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RVBA
  const lignes = Buffer.alloc(cote * (1 + cote * 4));
  for (let y = 0; y < cote; y += 1) {
    const depart = y * (1 + cote * 4);
    lignes[depart] = 0;
    rgba.copy(lignes, depart + 1, y * cote * 4, (y + 1) * cote * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr),
    bloc('IDAT', deflateSync(lignes, { level: 9 })),
    bloc('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- la géométrie */

const ENCRE = [0x1c, 0x18, 0x15];
const AMBRE = [0xe7, 0xa1, 0x3a];

/** Les quatre cerceaux de paille, et la demi-épaisseur du trait. */
const CERCEAUX = [16.5, 13.5, 10.5, 8];
const DEMI_TRAIT = 0.45;

/**
 * Bézier cubique du flanc GAUCHE du dôme, reprise du SVG : (4,6 ; 19) jusqu'au
 * sommet (12 ; 6,2). Le flanc droit est son miroir autour de x = 12 : c'est
 * déjà le cas dans le SVG, où la commande `S` produit exactement 19,4 = 24 − 4,6.
 */
const FLANC = [
  [4.6, 19],
  [4.6, 11],
  [7.7, 6.2],
  [12, 6.2],
];

const BASE = 19;
const SOMMET = 6.2;

/** Le flanc échantillonné, trié par hauteur décroissante (de la base au sommet). */
const PROFIL = (() => {
  const pas = 4096;
  const points = [];
  for (let i = 0; i <= pas; i += 1) {
    const t = i / pas;
    const u = 1 - t;
    const poids = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k += 1) {
      x += poids[k] * FLANC[k][0];
      y += poids[k] * FLANC[k][1];
    }
    points.push([y, x]);
  }
  return points;
})();

/** Abscisse du flanc gauche à la hauteur `y`, ou `null` hors du dôme. */
function flancGauche(y) {
  if (y > BASE || y < SOMMET) return null;
  let bas = 0;
  let haut = PROFIL.length - 1;
  while (haut - bas > 1) {
    const milieu = (bas + haut) >> 1;
    if (PROFIL[milieu][0] > y) bas = milieu;
    else haut = milieu;
  }
  const [y0, x0] = PROFIL[bas];
  const [y1, x1] = PROFIL[haut];
  const f = y0 === y1 ? 0 : (y - y0) / (y1 - y0);
  return x0 + f * (x1 - x0);
}

function dansDome(x, y) {
  const g = flancGauche(y);
  return g !== null && x >= g && x <= 24 - g;
}

/** Le trou d'envol : un demi-disque posé sur la base. */
function dansEntree(x, y) {
  const dx = x - 12;
  const dy = y - BASE;
  return dy <= 0 && dx * dx + dy * dy <= 1.4 * 1.4;
}

function dansRectArrondi(x, y, r) {
  if (x < 0 || y < 0 || x > 24 || y > 24) return false;
  const cx = Math.min(Math.max(x, r), 24 - r);
  const cy = Math.min(Math.max(y, r), 24 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Couleur du dessin au point (x, y) de l'espace 24 × 24 du SVG. */
function echantillon(x, y, arrondi) {
  if (arrondi && !dansRectArrondi(x, y, 5)) return [0, 0, 0, 0];
  if (dansEntree(x, y)) return [...ENCRE, 255];
  if (dansDome(x, y)) {
    for (const c of CERCEAUX) if (Math.abs(y - c) <= DEMI_TRAIT) return [...ENCRE, 255];
    return [...AMBRE, 255];
  }
  return [...ENCRE, 255];
}

/* ---------------------------------------------------------------- le rendu */

/** Sur-échantillonnage : 16 sous-pixels par pixel, assez pour que le dôme et
 *  les cerceaux n'aient pas d'escalier visible à 192 px. */
const SUR = 4;

/**
 * @param echelle  1 = le dessin occupe tout le carré. 0,7 = il est ramené au
 *                 centre, ce que réclame une icône `maskable` : Android y
 *                 découpe un cercle, et tout ce qui dépasse 80 % du côté peut
 *                 être rogné.
 */
function dessiner(cote, { arrondi, echelle }) {
  const pixels = Buffer.alloc(cote * cote * 4);
  const sousPixels = SUR * SUR;
  for (let py = 0; py < cote; py += 1) {
    for (let px = 0; px < cote; px += 1) {
      let r = 0;
      let v = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUR; sy += 1) {
        for (let sx = 0; sx < SUR; sx += 1) {
          let ux = ((px + (sx + 0.5) / SUR) / cote) * 24;
          let uy = ((py + (sy + 0.5) / SUR) / cote) * 24;
          if (echelle !== 1) {
            ux = 12 + (ux - 12) / echelle;
            uy = 12 + (uy - 12) / echelle;
          }
          const c = echantillon(ux, uy, arrondi);
          // Prémultiplié, sinon les bords transparents tirent vers le noir.
          r += c[0] * c[3];
          v += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (py * cote + px) * 4;
      pixels[i] = a ? Math.round(r / a) : 0;
      pixels[i + 1] = a ? Math.round(v / a) : 0;
      pixels[i + 2] = a ? Math.round(b / a) : 0;
      pixels[i + 3] = Math.round(a / sousPixels);
    }
  }
  return encoderPng(cote, pixels);
}

/* ---------------------------------------------------------------- l'écriture */

const SORTIE = fileURLToPath(new URL('../packages/app/public/', import.meta.url));

const ICONES = [
  // Coins arrondis et fond transparent : c'est l'icône d'onglet et de raccourci.
  { nom: 'icone-192.png', cote: 192, arrondi: true, echelle: 1 },
  { nom: 'icone-512.png', cote: 512, arrondi: true, echelle: 1 },
  // Pleine page, dessin réduit : Android applique son propre masque.
  { nom: 'icone-maskable-512.png', cote: 512, arrondi: false, echelle: 0.7 },
  // iOS arrondit lui-même et n'accepte pas la transparence : carré plein.
  { nom: 'apple-touch-icon.png', cote: 180, arrondi: false, echelle: 1 },
];

mkdirSync(SORTIE, { recursive: true });

for (const { nom, cote, arrondi, echelle } of ICONES) {
  const png = dessiner(cote, { arrondi, echelle });
  writeFileSync(join(SORTIE, nom), png);
  console.log(`  ${nom.padEnd(26)} ${String(cote).padStart(3)} px  ${(png.length / 1024).toFixed(1)} Ko`);
}

console.log(`\n${ICONES.length} icônes écrites dans packages/app/public/`);
