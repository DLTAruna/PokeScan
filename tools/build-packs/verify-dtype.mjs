// Est-ce que la PRÉCISION du modèle de requête décale le classement ?
//
// L'index global a été construit en fp32 (lib.mjs). Le téléphone, lui, choisit son moteur à
// l'exécution : webgpu/fp16, webgpu/fp32 ou, quand le GPU refuse l'adaptateur, wasm/q8. Rien
// ne garantit que deux quantifications du même DINOv2 placent une image au même endroit de
// l'espace : si elles divergent, la requête du téléphone est comparée à un index qui ne parle
// pas tout à fait la même langue, la bonne carte tombe hors de la shortlist, et l'ORB compare
// dix-huit mauvais candidats — exactement les 0 à 1 inlier relevés sur le terrain.
//
// On mesure donc la seule chose qui compte : le RANG de la bonne carte dans l'index fp32,
// selon la précision qui a calculé la requête. Même protocole que verify-global.mjs (crop
// ZONE, 320 px, JPEG q92), mêmes cartes pour toutes les précisions — sinon on comparerait
// des échantillons et non des moteurs.
//
//   node verify-dtype.mjs [N] [dtype,dtype,...]      défaut : 40 fp32,q8

import zlib from 'zlib';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { ZONE_ILLUSTRATION, telecharger } from './lib.mjs';

env.allowLocalModels = false;
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const N = process.argv[2] ? +process.argv[2] : 40;
const DTYPES = (process.argv[3] || 'fp32,q8').split(',');

const bin = await (await fetch(R2 + '/index-global.bin')).arrayBuffer();
let metaRaw = Buffer.from(await (await fetch(R2 + '/index-global-meta.json.gz')).arrayBuffer());
if (metaRaw[0] === 0x1f && metaRaw[1] === 0x8b) metaRaw = zlib.gunzipSync(metaRaw);
const meta = JSON.parse(metaRaw.toString());

const dv = new DataView(bin);
const count = dv.getUint32(0, true), D = dv.getUint32(4, true);
const q8 = new Int8Array(bin, 8, count * D);
const inv = new Float32Array(count);
for (let i = 0; i < count; i++) { let n = 0; for (let j = 0; j < D; j++) { const v = q8[i * D + j]; n += v * v; } inv[i] = 1 / (Math.sqrt(n) || 1); }
console.log(`index ${count} cartes · ${D} dims · construit en fp32\n`);

// Les mêmes cartes pour toutes les précisions, et leur image téléchargée UNE fois : le réseau
// est le coût dominant, et deux tirages différents rendraient la comparaison illisible.
const idx = [...Array(count).keys()];
for (let i = idx.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
const echantillon = [];
process.stdout.write('téléchargement des images… ');
for (const i of idx) {
  if (echantillon.length >= N) break;
  try { echantillon.push({ i, buf: await telecharger(meta[i].i + '/high.webp') }); } catch (e) {}
}
console.log(echantillon.length + ' cartes\n');

async function requete(ex, imgBuf) {
  const w = 320, h = Math.round(320 * 88 / 63);
  const base = await sharp(imgBuf).resize(w, h, { fit: 'fill' }).toBuffer();
  const region = { left: Math.round(w * ZONE_ILLUSTRATION.x), top: Math.round(h * ZONE_ILLUSTRATION.y),
                   width: Math.round(w * ZONE_ILLUSTRATION.w), height: Math.round(h * ZONE_ILLUSTRATION.h) };
  const jpg = await sharp(base).extract(region).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = await ex(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 4));
  let v = Float32Array.from(out.data); const d = out.dims || [];
  if (d.length === 3 && d[1] > 1) v = v.slice(0, d[2]);
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const resultats = {};
for (const dtype of DTYPES) {
  let ex;
  try { ex = await pipeline('image-feature-extraction', 'onnx-community/dinov2-small', { dtype }); }
  catch (e) { console.log(`${dtype} : indisponible ici (${String(e.message).slice(0, 60)})\n`); continue; }

  const rangs = [], hors = [];
  for (const { i, buf } of echantillon) {
    const ev = await requete(ex, buf);
    // rang de la BONNE carte : on compte combien de cartes la dépassent, sans trier 18 646
    // entrées pour n'en lire qu'une.
    let sVrai = 0; { const o = i * D; for (let j = 0; j < D; j++) sVrai += q8[o + j] * ev[j]; sVrai *= inv[i]; }
    let rang = 0, meilleur = -Infinity, kMeilleur = -1;
    for (let k = 0; k < count; k++) {
      let s = 0; const o = k * D; for (let j = 0; j < D; j++) s += q8[o + j] * ev[j]; s *= inv[k];
      if (s > sVrai) rang++;
      if (s > meilleur) { meilleur = s; kMeilleur = k; }
    }
    rangs.push(rang);
    if (rang >= 18) hors.push({ carte: meta[i].c, rang, vu: meta[kMeilleur].c });
  }

  rangs.sort((a, b) => a - b);
  const n = rangs.length;
  const pct = c => (100 * rangs.filter(r => r < c).length / n).toFixed(1);
  resultats[dtype] = { n, top1: pct(1), top5: pct(5), top18: pct(18),
                       med: rangs[n >> 1], p90: rangs[Math.floor(n * 0.9)], max: rangs[n - 1], hors };
  console.log(`── ${dtype} ──  top-1 ${pct(1)} %  top-5 ${pct(5)} %  top-18 ${pct(18)} %` +
              `   rang médian ${rangs[n >> 1]}, p90 ${rangs[Math.floor(n * 0.9)]}, max ${rangs[n - 1]}`);
  if (hors.length) { for (const h of hors.slice(0, 8)) console.log(`     hors shortlist : ${h.carte} rang ${h.rang} (vu ${h.vu})`); }
  console.log();
}

console.log('════ récapitulatif (index fp32) ════');
console.log('dtype   top-1   top-5  top-18   médian   p90    max');
for (const [d, r] of Object.entries(resultats))
  console.log(d.padEnd(7), String(r.top1).padStart(5), String(r.top5).padStart(6), String(r.top18).padStart(7),
              String(r.med).padStart(7), String(r.p90).padStart(6), String(r.max).padStart(6));
