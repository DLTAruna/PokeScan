// NIVEAU DE RÉFÉRENCE DE embTop — sans lui, le embTop du terrain ne veut rien dire.
// Mesuré le 2026-09-01 sur l'index à 18 646 cartes : art officiel propre 0,942 de médiane,
// le même art flouté et assombri exprès 0,839, et le téléphone de Nikos 0,687 (max 0,715).
// Le MEILLEUR scan du téléphone est donc sous la PIRE carte en art propre (0,836) : ce qui
// arrive à l'embedding sur l'appareil est plus dégradé qu'une image sabotée à la main.
// C'est ce qui a clos une enquête où j'avais accusé tour à tour le cache ORB, le moteur
// d'inférence, la taille du catalogue et la précision du modèle — tous innocents.
// Le piège à éviter : sur le terrain embTop ne CORRÈLE pas avec la réussite, ce dont j'avais
// conclu que l'image allait bien. Faux — toutes les valeurs étaient mauvaises, la corrélation
// disparaît par restriction d'étendue. Il faut comparer le NIVEAU, pas la pente.
import zlib from 'zlib';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { ZONE_ILLUSTRATION, telecharger } from './lib.mjs';
env.allowLocalModels = false;
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const N = +process.argv[2] || 25;
const bin = await (await fetch(R2 + '/index-global.bin')).arrayBuffer();
let mr = Buffer.from(await (await fetch(R2 + '/index-global-meta.json.gz')).arrayBuffer());
if (mr[0] === 0x1f && mr[1] === 0x8b) mr = zlib.gunzipSync(mr);
const meta = JSON.parse(mr.toString());
const dv = new DataView(bin), count = dv.getUint32(0, true), D = dv.getUint32(4, true);
const q8 = new Int8Array(bin, 8, count * D);
const inv = new Float32Array(count);
for (let i = 0; i < count; i++) { let n = 0; for (let j = 0; j < D; j++) { const v = q8[i*D+j]; n += v*v; } inv[i] = 1/(Math.sqrt(n)||1); }
const ex = await pipeline('image-feature-extraction', 'onnx-community/dinov2-small', { dtype: 'q8' });
const idx = [...Array(count).keys()];
for (let i = idx.length-1; i>0; i--) { const j = Math.random()*(i+1)|0; [idx[i],idx[j]]=[idx[j],idx[i]]; }
async function emb(buf, degrade) {
  const w = 320, h = Math.round(320*88/63);
  let p = sharp(buf).resize(w, h, { fit: 'fill' });
  if (degrade) p = p.blur(1.2).modulate({ brightness: 0.85 });
  const base = await p.toBuffer();
  const r = { left: Math.round(w*ZONE_ILLUSTRATION.x), top: Math.round(h*ZONE_ILLUSTRATION.y),
              width: Math.round(w*ZONE_ILLUSTRATION.w), height: Math.round(h*ZONE_ILLUSTRATION.h) };
  const jpg = await sharp(base).extract(r).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = await ex(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 4));
  let v = Float32Array.from(o.data); const d = o.dims||[];
  if (d.length===3 && d[1]>1) v = v.slice(0, d[2]);
  let n=0; for (let i=0;i<v.length;i++) n+=v[i]*v[i]; n=Math.sqrt(n)||1;
  for (let i=0;i<v.length;i++) v[i]/=n; return v;
}
const top = async (ev) => { let b=-1e9; for(let k=0;k<count;k++){ let s=0,o=k*D; for(let j=0;j<D;j++) s+=q8[o+j]*ev[j]; s*=inv[k]; if(s>b)b=s; } return b; };
const propres=[], flous=[];
let done=0;
for (const i of idx) { if (done>=N) break;
  let buf; try { buf = await telecharger(meta[i].i+'/high.webp'); } catch(e){ continue; }
  propres.push(await top(await emb(buf,false)));
  flous.push(await top(await emb(buf,true)));
  done++;
}
const st=a=>{const t=[...a].sort((x,y)=>x-y);return `min ${t[0].toFixed(3)}  méd ${t[t.length>>1].toFixed(3)}  max ${t[t.length-1].toFixed(3)}`;};
console.log(`\nembTop sur ${done} cartes (index 18 646, requête q8)`);
console.log('  art officiel propre :', st(propres));
console.log('  meme art degrade    :', st(flous));
console.log('\n  téléphone (V.37, 9 scans) : min 0.477  méd 0.687  max 0.715');
