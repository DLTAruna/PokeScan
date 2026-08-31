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
      const r = await fetch(url);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      derniere = new Error(r.status + ' ' + r.statusText);
      if (r.status === 404) break;
    } catch (e) { derniere = e; }
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

export async function cartesDuSet(setId) {
  const d = await (await fetch(`https://api.tcgdex.net/v2/${LOCALE}/sets/${setId}`)).json();
  const cartes = [];
  for (const c of (d.cards || [])) {
    if (!c.image || !/^\d+$/.test(String(c.localId || ''))) continue;
    cartes.push({
      cle: setId + '-' + c.localId, numero: String(parseInt(c.localId, 10)),
      setId, localId: c.localId, image: c.image, name: c.name || '',
    });
  }
  return { nom: d.name || setId, cartes };
}

export async function setsDeLaSerie(serieId) {
  const d = await (await fetch(`https://api.tcgdex.net/v2/${LOCALE}/series/${serieId}`)).json();
  return (d.sets || []).map(s => s.id);
}
