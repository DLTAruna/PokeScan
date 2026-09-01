// Fonctions partagées : calcul d'un pack (embeddings DINOv2 + descripteurs ORB + dHash)
// pour un set, dans un format IDENTIQUE à celui que le navigateur produit
// (scanner-test.html · serialiserPack). Le test de fidélité a montré que le décodage
// Node (sharp) donne des embeddings interchangeables avec ceux du navigateur.

import { pipeline, env, RawImage } from '@huggingface/transformers';
import sharp from 'sharp';
import cvReady from '@techstark/opencv-js';

env.allowLocalModels = false;

export const MODELE = 'onnx-community/dinov2-small';
export const LOCALE = 'fr';
export const ZONE_ILLUSTRATION = { x: 0.07, y: 0.11, w: 0.86, h: 0.43 };
export const NF = 700;                     // points ORB par référence (comme le navigateur)
export const PACK_MAGIC_V = 1;

let _cv = null, _ex = null;

export async function cv() {
  if (_cv) return _cv;
  _cv = await (cvReady.default || cvReady);
  if (_cv instanceof Promise) _cv = await _cv;
  if (typeof _cv === 'function') _cv = await _cv();
  if (!_cv.Mat) await new Promise(r => { _cv.onRuntimeInitialized = r; });
  return _cv;
}

export async function extracteur() {
  if (_ex) return _ex;
  // fp32 : le test de fidélité tourne dessus, et en Node c'est le chemin le plus sûr.
  _ex = await pipeline('image-feature-extraction', MODELE, { dtype: 'fp32' });
  return _ex;
}

export async function telecharger(url, essais = 4) {
  let derniere;
  for (let i = 0; i < essais; i++) {
    try {
      // Sans délai, une URL qui ne 404 pas proprement mais reste simplement muette (constaté
      // sur assets.tcgdex.net pour un dossier de set inexistant : la connexion ne se ferme
      // jamais) bloquait ce téléchargement indéfiniment — et avec lui tout le build, un
      // appel à la fois. Le CDN répond normalement en <1 s ; 10 s est déjà large.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      let r;
      try { r = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(t); }
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      derniere = new Error(r.status + ' ' + r.statusText);
      if (r.status === 404) break;
    } catch (e) {
      // Un DÉLAI DÉPASSÉ ne se résout pas en réessayant — c'est le même silence qui se
      // répète. Cas concret : les URL devinées pour les sets sans scan connu (voir
      // cartesDuSet, baseImage) tombent parfois sur un chemin qui n'existe nulle part ;
      // sans cette sortie anticipée, chacune aurait coûté 4 × 10 s au lieu d'une seule —
      // des dizaines de minutes perdues sur un lot de cartes qui ne se téléchargeront
      // jamais. Les vraies pannes réseau (connexion refusée, DNS) échouent vite et
      // profitent toujours des réessais normaux.
      if (e.name === 'AbortError') throw new Error('délai dépassé (10 s) — probablement aucune image à cette adresse');
      derniere = e;
    }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw derniere || new Error('échec téléchargement ' + url);
}

// —— embedding : recadre la zone d'illustration, JPEG q92 (comme toDataURL 0.92), CLS token, L2
export async function embedding(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width, H = meta.height;
  const region = {
    left: Math.round(W * ZONE_ILLUSTRATION.x), top: Math.round(H * ZONE_ILLUSTRATION.y),
    width: Math.round(W * ZONE_ILLUSTRATION.w), height: Math.round(H * ZONE_ILLUSTRATION.h),
  };
  const jpg = await sharp(imgBuf).extract(region).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 4);
  const ex = await extracteur();
  const out = await ex(img);
  let v = Float32Array.from(out.data);
  const d = out.dims || [];
  if (d.length === 3 && d[1] > 1) v = v.slice(0, d[2]);
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / n) * 127)));
  return q;
}

// —— dHash 8×8 sur la zone d'illustration (comme scanner-test.html · dHash)
export async function dhash(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width, H = meta.height;
  const region = {
    left: Math.round(W * ZONE_ILLUSTRATION.x), top: Math.round(H * ZONE_ILLUSTRATION.y),
    width: Math.round(W * ZONE_ILLUSTRATION.w), height: Math.round(H * ZONE_ILLUSTRATION.h),
  };
  const { data } = await sharp(imgBuf).extract(region).resize(9, 8, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const g = [];
  for (let i = 0; i < 72; i++) g.push(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1n : 0n);
  return bits;
}

// —— ORB : image entière → gris (cvtColor RGBA2GRAY, comme le navigateur) → ORB(700)
export async function orb(imgBuf) {
  const c = await cv();
  const jpg = await sharp(imgBuf).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const m = c.matFromArray(info.height, info.width, c.CV_8UC4, Array.from(data));
  const g = new c.Mat();
  c.cvtColor(m, g, c.COLOR_RGBA2GRAY); m.delete();
  const o = new c.ORB(NF);
  const kpv = new c.KeyPointVector(); const des = new c.Mat(); const nm = new c.Mat();
  o.detectAndCompute(g, nm, kpv, des);
  const rows = des.rows;
  const bytes = new Uint8Array(des.data);               // rows*32
  const kp = new Int16Array(rows * 2);
  for (let i = 0; i < rows; i++) { const p = kpv.get(i).pt; kp[i * 2] = Math.round(p.x); kp[i * 2 + 1] = Math.round(p.y); }
  kpv.delete(); o.delete(); nm.delete(); des.delete(); g.delete();
  return { rows, bytes, kp };
}

// —— sérialisation pack, identique à serialiserPack (navigateur)
export function serialiserPack(setId, rows) {
  const embDim = rows[0].emb.length;
  const header = { v: PACK_MAGIC_V, set: setId, model: MODELE, embDim, cards: [] };
  const parts = [];
  for (const r of rows) {
    header.cards.push({ cle: r.cle, num: r.numero, name: r.name || '', img: r.image, hash: String(r.hash), or: r.rows });
    parts.push(Buffer.from(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength));
    parts.push(Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength));
    parts.push(Buffer.from(r.kp.buffer, r.kp.byteOffset, r.kp.byteLength));
  }
  const hj = Buffer.from(JSON.stringify(header), 'utf-8');
  const head = Buffer.alloc(4); head.writeUInt32LE(hj.length, 0);
  return Buffer.concat([head, hj, ...parts]);
}

// Sous-sets dont TCGdex n'expose l'URL d'illustration NULLE PART (ni sur la liste du set, ni
// sur la fiche carte individuelle, dans aucune langue — vérifié à la main) : Galerie de
// Dresseurs (…tg), Galerie Galaroise (…gg), Coffre Étincelant (…sv, suffixe de swsh4.5sv).
// Leurs images vivent en réalité dans le dossier du set PARENT, sous le même numéro local —
// deviné puis confirmé en interrogeant assets.tcgdex.net directement sur plusieurs cartes de
// chaque sous-set. Un suffixe non listé ici (les Collections Classiques, …cc) n'est PAS
// deviné : mieux vaut laisser ces quelques cartes de côté que risquer la mauvaise image.
const SUFFIXES_SOUS_SET = ['tg', 'gg', 'sv'];

// Beaucoup de sets anciens ou promotionnels (Diamant & Perle, L'appel des Légendes, la
// plupart des promos SM/HGSS…) n'ont simplement jamais été scannés en français chez TCGdex —
// `c.image` est absent pour TOUTES leurs cartes, dans les deux endpoints. L'illustration
// anglaise, elle, existe presque toujours et c'est la même carte : mêmes dimensions, même
// zone d'illustration, seul le texte diffère — sans conséquence pour une identification
// visuelle qui ne lit jamais le texte. Vérifié sur un échantillon de 53 sets : environ
// 1 550 cartes supplémentaires deviennent exploitables par ce seul repli.
//
// C'est un PARI, pas une certitude : environ 860 cartes de l'échantillon (surtout les kits
// du dresseur et les collections McDonald's) n'ont d'image ni en français ni en anglais —
// probablement jamais numérisées nulle part. Pour elles, cette URL devinée échouera. On
// tente quand même plutôt que d'exclure ces sets en bloc (certaines de leurs cartes ONT une
// image, seule la minorité sans image profite du pari) ; le coût d'un pari perdant est
// borné à un seul essai rapide (voir telecharger : pas de réessai sur un délai dépassé).
// Nikos : pour un premier build, laisser `tk` et `mc` décochés dans build.html évite le
// plus gros de ces paris perdus d'avance.
function baseImage(c, setId, serieId) {
  if (c.image) return c.image;
  for (const suf of SUFFIXES_SOUS_SET) {
    if (setId.length > suf.length && setId.endsWith(suf)) {
      return `https://assets.tcgdex.net/${LOCALE}/${serieId}/${setId.slice(0, -suf.length)}/${c.localId}`;
    }
  }
  return `https://assets.tcgdex.net/en/${serieId}/${setId}/${c.localId}`;
}

export async function cartesDuSet(setId) {
  const d = await (await fetch(`https://api.tcgdex.net/v2/${LOCALE}/sets/${setId}`)).json();
  const serieId = d.serie?.id || setId;
  const cartes = [];
  for (const c of (d.cards || [])) {
    // Seule condition réelle : une illustration à indexer. L'ancien filtre exigeait un
    // localId PUREMENT numérique — ça excluait sans le dire des sets entiers dont TOUTES
    // les cartes sont numérotées autrement : les promos (SWSH001…), la Galerie de
    // Dresseurs (TG01…), la Galerie Galaroise (GG01…), les coffres (SV001…), les
    // collections classiques (CC001…). Ces sets tombaient à 0 carte exploitable et
    // restaient marqués « à construire » indéfiniment — pas parce qu'ils manquaient
    // vraiment, mais parce que le filtre les rejetait entièrement, en silence.
    const localId = String(c.localId || '').trim();
    if (!localId) continue;   // une carte sans numéro n'a pas de clé stable — jamais rencontré, garde-fou
    const image = baseImage(c, setId, serieId);
    // Le numéro affiché suit ce qui est réellement imprimé sur la carte : les zéros de
    // tête sautent pour un numéro purement numérique (« 025 » → « 25 », comme avant) ;
    // un identifiant alphanumérique (« TG01 ») reste tel quel, c'est son vrai numéro.
    const numero = /^\d+$/.test(localId) ? String(parseInt(localId, 10)) : localId;
    cartes.push({
      cle: setId + '-' + localId, numero,
      setId, localId, image, name: c.name || '',
    });
  }
  return { nom: d.name || setId, cartes };
}

export async function setsDeLaSerie(serieId) {
  const d = await (await fetch(`https://api.tcgdex.net/v2/${LOCALE}/series/${serieId}`)).json();
  return (d.sets || []).map(s => s.id);
}
