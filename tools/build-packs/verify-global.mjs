// L'index global (7591 cartes) : la bonne carte reste-t-elle dans la shortlist (top-30)
// de l'embedding ? Requête calculée comme identifierV2 (crop ZONE, 320 px, JPEG q92).

import zlib from 'zlib';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { ZONE_ILLUSTRATION, telecharger } from './lib.mjs';

env.allowLocalModels = false;
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const SHORT = 30;
const N = process.argv[2] ? +process.argv[2] : 40;

const bin = await (await fetch(R2 + '/index-global.bin')).arrayBuffer();
let metaRaw = Buffer.from(await (await fetch(R2 + '/index-global-meta.json.gz')).arrayBuffer());
if (metaRaw[0] === 0x1f && metaRaw[1] === 0x8b) metaRaw = zlib.gunzipSync(metaRaw);
const meta = JSON.parse(metaRaw.toString());

const dv = new DataView(bin);
const count = dv.getUint32(0, true), D = dv.getUint32(4, true);
const q8 = new Int8Array(bin, 8, count * D);
console.log('index:', count, 'cartes ·', D, 'dims · meta', meta.length);

const inv = new Float32Array(count);
for (let i = 0; i < count; i++) { let n = 0; for (let j = 0; j < D; j++) { const v = q8[i * D + j]; n += v * v; } inv[i] = 1 / (Math.sqrt(n) || 1); }

const ex = await pipeline('image-feature-extraction', 'onnx-community/dinov2-small', { dtype: 'fp32' });

async function requete(imgBuf) {
  // comme identifierV2 : dessine la carte à 320 px de large, puis crop ZONE, JPEG q92
  const meta0 = await sharp(imgBuf).metadata();
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

// échantillon aléatoire
const idx = [...Array(count).keys()];
for (let i = idx.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
const sample = idx.slice(0, N);

let top1 = 0, top5 = 0, top30 = 0; const rangs = []; const rates = [];
for (const i of sample) {
  const m = meta[i];
  let buf;
  try { buf = await telecharger(m.i + '/high.webp'); } catch (e) { console.log('skip', m.c, e.message); continue; }
  const ev = await requete(buf);
  // cosinus vs tout l'index
  let scored = new Array(count);
  for (let k = 0; k < count; k++) { let s = 0; const o = k * D; for (let j = 0; j < D; j++) s += q8[o + j] * ev[j]; scored[k] = { k, s: s * inv[k] }; }
  scored.sort((a, b) => b.s - a.s);
  const rank = scored.findIndex(x => x.k === i);
  rangs.push(rank);
  if (rank === 0) top1++;
  if (rank < 5) top5++;
  if (rank < SHORT) top30++; else rates.push({ c: m.c, rank, top: meta[scored[0].k].c });
}
const n = rangs.length;
rangs.sort((a, b) => a - b);
console.log(`\n===== ${n} cartes =====`);
console.log(`top-1  ${top1}/${n}  (${(100*top1/n).toFixed(1)} %)`);
console.log(`top-5  ${top5}/${n}  (${(100*top5/n).toFixed(1)} %)`);
console.log(`top-${SHORT} ${top30}/${n}  (${(100*top30/n).toFixed(1)} %)   ← ce qui compte : la bonne carte est-elle dans la shortlist ORB ?`);
console.log(`rang médian ${rangs[n>>1]}, p90 ${rangs[Math.floor(n*0.9)]}, max ${rangs[n-1]}`);
if (rates.length) { console.log('\nhors shortlist :'); for (const r of rates) console.log('  ', JSON.stringify(r)); }
