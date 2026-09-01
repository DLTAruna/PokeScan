// ════════════════════════════════════════════════════════════════════════════════════════
// BANC DE DÉCLENCHEMENT — quelle image faut-il identifier ?
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Ce que les bancs précédents ont établi : le flou domine tout. Sur les trente et une vraies
// photos, un flou de 3 fait passer les rebuts de 19 % à 58 %, et « demi-résolution + flou
// 1,5 » les porte à 65 % avec cinq inliers médians — soit le terrain de Nikos à un point près.
// La chaîne d'identification, elle, se porte bien : 23/31 sur le témoin.
//
// Le scanner déclenche aujourd'hui sur la STABILITÉ : quand les coins cessent de bouger, il
// prend l'image de l'instant. Or une main peut être parfaitement immobile pendant que
// l'objectif, lui, cherche sa mise au point. La stabilité ne dit rien de la netteté.
//
// On compare donc trois politiques de choix de l'image, sur des séquences où l'appareil fait
// son va-et-vient de mise au point :
//
//   courante   — l'image de l'instant du déclenchement.        (ce que fait le scanner)
//   meilleure  — la plus nette de la fenêtre écoulée, gardée    (« best-shot »)
//                en mémoire, identifiée à sa place.
//   pic        — on attend que la netteté ait atteint son
//                sommet puis redescende, et on prend le sommet.
//
// ⚠️ POURQUOI DE L'ART PROPRE ET NON LES PHOTOS RÉELLES. Nikos : « elles contiennent un
// arrière-plan ». Il a raison, et pour ce banc-ci c'est même un avantage décisif : en
// fabriquant la séquence de mise au point, on SAIT quelle image est la plus nette. Sur une
// vraie vidéo, la vérité terrain n'existe pas — on ne pourrait pas dire si une politique a
// choisi la bonne image, seulement si elle a bien identifié, ce qui mélange deux questions.
//
// ⚠️ CE QUE CE BANC NE PEUT PAS DIRE. Il ne mesure pas la détection des coins, ni le
// redressement, ni le comportement de l'autofocus réel — il les suppose. Il répond à une
// seule question : à séquence donnée, quelle politique choisit la meilleure image, et ce que
// ça change à l'identification. Ne pas lui faire dire que le scanner est réparé.
//
//   node banc-declenchement.mjs [N]        défaut : 20 cartes
//
import zlib from 'zlib';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { ZONE_ILLUSTRATION, telecharger } from './lib.mjs';

env.allowLocalModels = false;
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const N = +process.argv[2] || 20;
const W = 320, H = Math.round(320 * 88 / 63);

// ── index ───────────────────────────────────────────────────────────────────────────────
const bin = await (await fetch(R2 + '/index-global.bin')).arrayBuffer();
let mr = Buffer.from(await (await fetch(R2 + '/index-global-meta.json.gz')).arrayBuffer());
if (mr[0] === 0x1f && mr[1] === 0x8b) mr = zlib.gunzipSync(mr);
const meta = JSON.parse(mr.toString());
const dv = new DataView(bin), count = dv.getUint32(0, true), D = dv.getUint32(4, true);
const q8 = new Int8Array(bin, 8, count * D);
const inv = new Float32Array(count);
for (let i = 0; i < count; i++) { let n = 0; for (let j = 0; j < D; j++) { const v = q8[i*D+j]; n += v*v; } inv[i] = 1/(Math.sqrt(n)||1); }
const ex = await pipeline('image-feature-extraction', 'onnx-community/dinov2-small', { dtype: 'q8' });

// ── netteté : variance du laplacien, comme index.html ───────────────────────────────────
// Calculée sur l'image telle qu'elle serait capturée. Rappel du banc précédent : cette valeur
// dépend AUTANT de l'illustration que de la mise au point, donc elle ne vaut rien en absolu.
// Ici on ne l'utilise QUE de façon relative, entre les images d'une même séquence — même
// carte, même contenu — ce qui est précisément le cas où elle est fiable.
async function nettete(buf) {
  const w = 220, h = Math.round(H * (w / W));
  const { data } = await sharp(buf).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y*w + x;
    const L = 4*data[p] - data[p-1] - data[p+1] - data[p-w] - data[p+w];
    sum += L; sq += L*L; n++;
  }
  const m = sum / n;
  return sq / n - m * m;
}

async function identifie(buf, vraiIdx) {
  const r = { left: Math.round(W*ZONE_ILLUSTRATION.x), top: Math.round(H*ZONE_ILLUSTRATION.y),
              width: Math.round(W*ZONE_ILLUSTRATION.w), height: Math.round(H*ZONE_ILLUSTRATION.h) };
  const jpg = await sharp(buf).extract(r).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = await ex(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 4));
  let v = Float32Array.from(o.data); const d = o.dims || [];
  if (d.length === 3 && d[1] > 1) v = v.slice(0, d[2]);
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i]*v[i]; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  let best = -Infinity, kBest = -1, sVrai = 0, rang = 0;
  for (let k = 0; k < count; k++) {
    let s = 0, o2 = k*D; for (let j = 0; j < D; j++) s += q8[o2+j]*v[j]; s *= inv[k];
    if (k === vraiIdx) sVrai = s;
    if (s > best) { best = s; kBest = k; }
  }
  for (let k = 0; k < count; k++) { let s = 0, o2 = k*D; for (let j = 0; j < D; j++) s += q8[o2+j]*v[j]; if (s*inv[k] > sVrai) rang++; }
  return { juste: kBest === vraiIdx, embTop: best, rang };
}

// ── la séquence : ce que la caméra voit pendant que l'objectif cherche ───────────────────
// Une chasse au point réaliste : l'appareil part flou, dépasse le point net, revient. La main
// tremble un peu (décalage de quelques pixels) et la carte n'occupe pas tout le cadre. Le
// sommet de netteté ne tombe JAMAIS sur la dernière image — sinon « courante » gagnerait par
// construction et le banc ne prouverait rien.
const COURBE_FLOU = [3.2, 2.4, 1.6, 0.9, 0.35, 0.15, 0.5, 1.1, 1.9, 2.6, 3.0, 2.2];
const SOMMET_VRAI = 5;   // l'indice de la plus nette, par construction

async function sequence(buf) {
  const frames = [];
  for (let i = 0; i < COURBE_FLOU.length; i++) {
    const px = 150 + (i % 3) * 6;                      // la carte respire un peu dans le cadre
    const dx = ((i * 7) % 5) - 2, dy = ((i * 3) % 5) - 2;   // tremblement de main
    let img = await sharp(buf).resize(px, Math.round(px*88/63), { fit: 'fill' }).toBuffer();
    img = await sharp(img).resize(W + 4, H + 4, { fit: 'fill' }).toBuffer();
    img = await sharp(img).extract({ left: 2 + dx, top: 2 + dy, width: W, height: H }).toBuffer();
    let p = sharp(img);
    if (COURBE_FLOU[i] > 0.2) p = p.blur(COURBE_FLOU[i]);
    p = p.modulate({ brightness: 0.8 });               // éclairage d'intérieur
    frames.push(await p.toBuffer());
  }
  return frames;
}

// ── les politiques ──────────────────────────────────────────────────────────────────────
// Chacune reçoit les netteté image par image et rend l'INDICE choisi. `declenche` est
// l'instant où la stabilité déclenche aujourd'hui : on le place volontairement APRÈS le
// sommet, cas le plus fréquent — la main se pose, puis l'objectif finit sa course.
const DECLENCHE = 9;
const FENETRE = 8;   // combien d'images en arrière la mémoire garde (≈ 0,8 s à 10 Hz)

const POLITIQUES = {
  courante: (net) => DECLENCHE,

  meilleure: (net) => {
    let k = Math.max(0, DECLENCHE - FENETRE + 1), best = k;
    for (; k <= DECLENCHE; k++) if (net[k] > net[best]) best = k;
    return best;
  },

  // Attendre que la netteté ait culminé puis redescendu deux fois de suite. Coûte des images
  // — donc du temps — et peut ne jamais se déclencher si l'objectif ne redescend pas ; dans
  // ce cas on retombe sur l'instant de stabilité.
  pic: (net) => {
    for (let i = 2; i < net.length - 2; i++)
      if (net[i] > net[i-1] && net[i] > net[i-2] && net[i] > net[i+1] && net[i] > net[i+2]) return i;
    return DECLENCHE;
  },
};

// ── échantillon ─────────────────────────────────────────────────────────────────────────
const idx = [...Array(count).keys()];
for (let i = idx.length-1; i>0; i--) { const j = Math.random()*(i+1)|0; [idx[i],idx[j]]=[idx[j],idx[i]]; }
process.stdout.write('téléchargement… ');
const cartes = [];
for (const i of idx) { if (cartes.length >= N) break;
  try { cartes.push({ i, buf: await telecharger(meta[i].i + '/high.webp') }); } catch (e) {} }
console.log(`${cartes.length} cartes · index ${count}\n`);
console.log(`séquence de ${COURBE_FLOU.length} images, sommet de netteté à l'indice ${SOMMET_VRAI},`);
console.log(`stabilité déclenchée à l'indice ${DECLENCHE} (après le sommet, comme sur le terrain)\n`);

const stats = {}; for (const p of Object.keys(POLITIQUES)) stats[p] = { justes: 0, embTop: [], rangs: [], choisi: [] };

for (const { i, buf } of cartes) {
  const frames = await sequence(buf);
  const net = []; for (const f of frames) net.push(await nettete(f));
  for (const [nom, choisir] of Object.entries(POLITIQUES)) {
    const k = choisir(net);
    const r = await identifie(frames[k], i);
    const s = stats[nom];
    if (r.juste) s.justes++;
    s.embTop.push(r.embTop); s.rangs.push(r.rang); s.choisi.push(k);
  }
}

const med = a => { const t = [...a].sort((x,y)=>x-y); return t[t.length>>1]; };
const n = cartes.length;
console.log('politique    justes      embTop méd   rang méd   image choisie (méd)');
for (const [nom, s] of Object.entries(stats))
  console.log(nom.padEnd(12),
    `${String(s.justes).padStart(2)}/${n} (${String(Math.round(100*s.justes/n)).padStart(3)} %)`,
    String(med(s.embTop).toFixed(3)).padStart(11),
    String(med(s.rangs)).padStart(10),
    String(med(s.choisi)).padStart(12) + (med(s.choisi) === SOMMET_VRAI ? '  ← le sommet' : ''));

console.log('\nRappel : « courante » est la politique actuelle du scanner.');
