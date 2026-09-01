// ════════════════════════════════════════════════════════════════════════════════════════
// BANC DES DÉGRADATIONS — quelle avarie de la chaîne de capture reproduit le terrain ?
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Le téléphone laisse une empreinte chiffrée, relevée en V.37 sur neuf scans :
//
//     embTop  min 0,477   médian 0,687   max 0,715
//
// Et deux niveaux de référence, mesurés par verify-embtop.mjs sur le même index :
//
//     art officiel propre                      0,942
//     le même, flouté et assombri exprès       0,839
//
// Le meilleur scan du téléphone passe donc sous la PIRE carte en art propre (0,836). Ce qui
// arrive à l'embedding sur l'appareil est plus abîmé qu'une image sabotée à la main — mais
// « abîmé » ne dit pas COMMENT, et c'est tout le problème : flou, carte trop petite, mauvais
// recadrage et erreur de perspective laissent la même trace dans un seul nombre.
//
// D'où ce banc. On part d'art officiel propre, on applique UNE avarie à la fois, on balaie
// son intensité, et on cherche laquelle amène embTop dans la bande du téléphone. Une avarie
// qui n'y descend jamais est innocentée ; celle qui y tombe pile devient le suspect.
//
// ⚠️ Ce banc mesure l'ENTRÉE de la reconnaissance, pas sa sortie. Il dit quelle image
// ressemble à celle du terrain, pas si l'ORB s'en sortirait — l'ORB a sa propre bimodalité,
// qui se mesure ailleurs. Ne pas lui faire dire qu'un réglage « répare » quoi que ce soit.
//
// Pourquoi ce banc existe : cinq hypothèses ont été poussées en production et démenties par
// les logs (cache ORB vide, moteur d'inférence, taille du catalogue, précision du modèle,
// puis « l'image va bien »). Chacune a coûté une salve de scans à Nikos. Toute hypothèse
// testable ici doit l'être ici d'abord.
//
//   node banc-degradations.mjs [N]        défaut : 12 cartes
//
import zlib from 'zlib';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';
import { ZONE_ILLUSTRATION, telecharger } from './lib.mjs';

env.allowLocalModels = false;
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const N = +process.argv[2] || 12;

// Ce que le téléphone a rendu en V.37 — la cible à reproduire.
const TERRAIN = { min: 0.477, med: 0.687, max: 0.715 };
const W = 320, H = Math.round(320 * 88 / 63);   // la carte redressée, comme identifierV2

// ── index ───────────────────────────────────────────────────────────────────────────────
const bin = await (await fetch(R2 + '/index-global.bin')).arrayBuffer();
let mr = Buffer.from(await (await fetch(R2 + '/index-global-meta.json.gz')).arrayBuffer());
if (mr[0] === 0x1f && mr[1] === 0x8b) mr = zlib.gunzipSync(mr);
const meta = JSON.parse(mr.toString());
const dv = new DataView(bin), count = dv.getUint32(0, true), D = dv.getUint32(4, true);
const q8 = new Int8Array(bin, 8, count * D);
const inv = new Float32Array(count);
for (let i = 0; i < count; i++) { let n = 0; for (let j = 0; j < D; j++) { const v = q8[i*D+j]; n += v*v; } inv[i] = 1/(Math.sqrt(n)||1); }

// q8 : la précision réellement utilisée par le téléphone quand le GPU refuse l'adaptateur,
// ce qui est son cas le plus fréquent. verify-dtype.mjs a montré que le choix ne change pas
// le classement, mais autant mesurer dans les conditions du terrain.
const ex = await pipeline('image-feature-extraction', 'onnx-community/dinov2-small', { dtype: 'q8' });

// ── la chaîne standard : carte redressée → 320 px → zone d'illustration → embedding ──────
async function embTop(carteBuf) {
  const r = { left: Math.round(W*ZONE_ILLUSTRATION.x), top: Math.round(H*ZONE_ILLUSTRATION.y),
              width: Math.round(W*ZONE_ILLUSTRATION.w), height: Math.round(H*ZONE_ILLUSTRATION.h) };
  const jpg = await sharp(carteBuf).extract(r).jpeg({ quality: 92 }).toBuffer();
  const { data, info } = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = await ex(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 4));
  let v = Float32Array.from(o.data); const d = o.dims || [];
  if (d.length === 3 && d[1] > 1) v = v.slice(0, d[2]);
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i]*v[i]; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  let best = -Infinity;
  for (let k = 0; k < count; k++) { let s = 0, o2 = k*D; for (let j = 0; j < D; j++) s += q8[o2+j]*v[j]; s *= inv[k]; if (s > best) best = s; }
  return best;
}

// ── les avaries, une par mécanisme physique ─────────────────────────────────────────────
// Chacune reçoit l'art d'origine et rend une carte redressée 320×447, comme si la chaîne de
// capture l'avait produite. L'intensité 0 doit toujours redonner l'image propre : c'est le
// témoin qui prouve que l'avarie, et non le banc, fait baisser le score.
const base = buf => sharp(buf).resize(W, H, { fit: 'fill' });

const AVARIES = {
  // Mise au point ratée. Nikos : « mon téléphone fait des focus étrange ».
  flou: { unite: 'sigma', valeurs: [0, 0.5, 1, 1.5, 2, 3, 4],
    f: (buf, v) => (v ? base(buf).blur(v) : base(buf)).toBuffer() },

  // Carte trop petite dans le viseur : le redressé est ré-agrandi depuis peu de pixels.
  // C'est l'avarie que « rapproche la carte » sous-entend.
  petite: { unite: 'px source', valeurs: [320, 240, 180, 140, 100, 70, 50],
    f: async (buf, v) => sharp(await sharp(buf).resize(v, Math.round(v*88/63), { fit: 'fill' }).toBuffer())
                           .resize(W, H, { fit: 'fill' }).toBuffer() },

  // Sous-exposition : le mode nuit qui s'invite, ou simplement la pénombre.
  sombre: { unite: 'luminosite', valeurs: [1, 0.85, 0.7, 0.55, 0.4, 0.3],
    f: (buf, v) => base(buf).modulate({ brightness: v }).toBuffer() },

  // Compression : la photo passe par un JPEG avant d'arriver au modèle.
  jpeg: { unite: 'qualite', valeurs: [95, 80, 60, 40, 25, 15],
    f: async (buf, v) => sharp(await base(buf).jpeg({ quality: v }).toBuffer()).toBuffer() },

  // Coins mal placés : le redressé est décalé, il mord le décor d'un côté et rogne la carte
  // de l'autre. Décalage exprimé en % de la largeur de carte.
  decale: { unite: '% decalage', valeurs: [0, 2, 5, 8, 12, 18],
    f: async (buf, v) => {
      const dx = Math.round(W * v / 100), dy = Math.round(H * v / 100);
      const grand = await sharp(buf).resize(W + 2*dx, H + 2*dy, { fit: 'fill' }).toBuffer();
      return sharp(grand).extract({ left: 2*dx, top: 2*dy, width: W, height: H }).toBuffer();
    } },

  // Erreur d'échelle : la stratégie « coins-0.80 » rétrécit les coins de 20 %. Si les coins
  // étaient déjà justes, elle entre DANS la carte ; s'ils étaient trop larges, elle corrige.
  echelle: { unite: 'facteur', valeurs: [1, 0.95, 0.9, 0.85, 0.8, 0.7, 1.1, 1.2],
    f: async (buf, v) => {
      if (v === 1) return base(buf).toBuffer();
      if (v < 1) {   // on zoome dans la carte
        const m = (1 - v) / 2;
        const g = await base(buf).toBuffer();
        return sharp(g).extract({ left: Math.round(W*m), top: Math.round(H*m),
                                  width: Math.round(W*v), height: Math.round(H*v) })
                       .resize(W, H, { fit: 'fill' }).toBuffer();
      }
      // on prend plus large que la carte : du décor entre dans le cadre (fond gris neutre)
      const petit = await sharp(buf).resize(Math.round(W/v), Math.round(H/v), { fit: 'fill' }).toBuffer();
      return sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 90, b: 95 } } })
        .composite([{ input: petit, gravity: 'center' }]).png().toBuffer();
    } },

  // Rotation résiduelle : l'homographie n'a pas tout à fait redressé.
  // ⚠️ Le témoin passe par le MÊME agrandissement 1,4× et le même recadrage que les autres
  // intensités. Première version : le témoin rendait l'image directe, si bien que 0° valait
  // 0,945 et 1° tombait à 0,760 — j'ai failli conclure que la rotation coûtait 0,18, alors
  // que la chute mesurait mon propre double ré-échantillonnage. Un témoin qui ne subit pas
  // le traitement du banc ne mesure pas l'avarie, il mesure le banc.
  tourne: { unite: 'degres', valeurs: [0, 1, 2, 4, 7, 12],
    f: async (buf, v) => {
      const g = await sharp(buf).resize(Math.round(W*1.4), Math.round(H*1.4), { fit: 'fill' }).toBuffer();
      const t = v ? await sharp(g).rotate(v, { background: { r: 90, g: 90, b: 95 } }).toBuffer() : g;
      const m = await sharp(t).metadata();
      return sharp(t).extract({ left: Math.round((m.width-W)/2), top: Math.round((m.height-H)/2), width: W, height: H }).toBuffer();
    } },

  // Combinaisons : sur le terrain les avaries ne se présentent pas une par une. Aucune n'a
  // atteint la bande du téléphone à une intensité plausible ; reste à savoir si deux ou
  // trois avaries MODÉRÉES, chacune anodine, suffisent à y descendre ensemble.
  cumul: { unite: 'scenario', valeurs: [0, 1, 2, 3, 4],
    f: async (buf, v) => {
      const S = [
        {},                                             // 0 : témoin
        { px: 180, flou: 0.8 },                         // 1 : carte un peu loin, mise au point molle
        { px: 180, flou: 0.8, lum: 0.7 },               // 2 : … et pénombre
        { px: 140, flou: 1.2, lum: 0.7, dec: 5 },       // 3 : … et coins un peu faux
        { px: 100, flou: 1.5, lum: 0.6, dec: 8 },       // 4 : main tendue, tout cumulé
      ][v];
      let img = buf;
      if (S.px) img = await sharp(await sharp(img).resize(S.px, Math.round(S.px*88/63), { fit:'fill' }).toBuffer())
                       .resize(W, H, { fit:'fill' }).toBuffer();
      let p = sharp(img).resize(W, H, { fit: 'fill' });
      if (S.flou) p = p.blur(S.flou);
      if (S.lum) p = p.modulate({ brightness: S.lum });
      let out = await p.toBuffer();
      if (S.dec) {
        const dx = Math.round(W*S.dec/100), dy = Math.round(H*S.dec/100);
        const grand = await sharp(out).resize(W + 2*dx, H + 2*dy, { fit:'fill' }).toBuffer();
        out = await sharp(grand).extract({ left: 2*dx, top: 2*dy, width: W, height: H }).toBuffer();
      }
      return out;
    } },

  // Rapport d'aspect faussé : la carte n'est pas vue de face, ou le `fit: fill` étire.
  etire: { unite: '% etirement', valeurs: [0, 3, 6, 10, 15, 22],
    f: async (buf, v) => {
      const h2 = Math.round(H * (1 + v/100));
      return sharp(await sharp(buf).resize(W, h2, { fit: 'fill' }).toBuffer())
        .resize(W, H, { fit: 'fill' }).toBuffer();
    } },

  // Reflet du toploader : une bande claire en travers de l'illustration.
  reflet: { unite: 'opacite %', valeurs: [0, 15, 30, 45, 60],
    f: async (buf, v) => {
      const g = await base(buf).toBuffer();
      if (!v) return g;
      const bande = await sharp({ create: { width: W, height: Math.round(H*0.35), channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: v/100 } } }).png().toBuffer();
      return sharp(g).composite([{ input: bande, top: Math.round(H*0.12), left: 0 }]).toBuffer();
    } },
};

// ── échantillon ─────────────────────────────────────────────────────────────────────────
const idx = [...Array(count).keys()];
for (let i = idx.length-1; i>0; i--) { const j = Math.random()*(i+1)|0; [idx[i],idx[j]]=[idx[j],idx[i]]; }
process.stdout.write(`téléchargement… `);
const cartes = [];
for (const i of idx) { if (cartes.length >= N) break;
  try { cartes.push(await telecharger(meta[i].i + '/high.webp')); } catch (e) {} }
console.log(`${cartes.length} cartes · index ${count}\n`);

const med = a => { const t = [...a].sort((x,y)=>x-y); return t[t.length>>1]; };
const dansLaBande = m => m <= TERRAIN.max && m >= TERRAIN.min;

console.log(`cible terrain : embTop médian ${TERRAIN.med}  (bande ${TERRAIN.min} – ${TERRAIN.max})`);
console.log(`repères       : art propre 0,942 · art saboté à la main 0,839\n`);

const verdicts = [];
for (const [nom, av] of Object.entries(AVARIES)) {
  console.log(`── ${nom} (${av.unite})`);
  let atteint = null;
  for (const v of av.valeurs) {
    const scores = [];
    for (const buf of cartes) { try { scores.push(await embTop(await av.f(buf, v))); } catch (e) {} }
    if (!scores.length) { console.log(`   ${String(v).padStart(7)} : —`); continue; }
    const m = med(scores);
    const marque = dansLaBande(m) ? '  ◀ BANDE DU TÉLÉPHONE' : (m < TERRAIN.min ? '  (sous le terrain)' : '');
    console.log(`   ${String(v).padStart(7)} : ${m.toFixed(3)}${marque}`);
    if (dansLaBande(m) && atteint === null) atteint = v;
  }
  verdicts.push({ nom, unite: av.unite, atteint });
  console.log();
}

console.log('════ verdict ════');
console.log("Une avarie n'est suspecte que si elle atteint la bande du téléphone à une");
console.log("intensité PLAUSIBLE sur l'appareil. Celles qui n'y descendent jamais sont hors de");
console.log('cause à elles seules.\n');
for (const v of verdicts)
  console.log('  ' + v.nom.padEnd(10),
    v.atteint === null ? 'jamais dans la bande  → innocentée seule'
                       : `atteint la bande à ${v.atteint} ${v.unite}`);

// ════════════════════════════════════════════════════════════════════════════════════════
// CE QUE CE BANC A ÉTABLI — 2026-09-01
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Aucune avarie SEULE n'atteint la bande du téléphone à une intensité plausible. Ce sont
// quatre imperfections modérées qui l'y amènent ensemble (scénario « cumul 3 » : carte à
// 140 px, flou 1,2, luminosité 0,7, coins faux de 5 % → embTop 0,653, contre 0,687 relevé
// sur l'appareil). Chacune prise à part serait passée pour anodine.
//
// Le banc de bout en bout (bench-v2.html, 31 vraies photos, vraie chaîne) désigne le terme
// dominant. Rebuts, et inliers médians :
//
//     témoin                      6/31  (19 %)   inliers 38
//     quart de résolution        10/31  (32 %)   inliers 21
//     luminosité 0,4              8/31  (26 %)   inliers 29
//     rotation 6°                10/31  (32 %)   inliers 32
//     FLOU 3                     18/31  (58 %)   inliers  7
//     demi-résolution + flou 1,5  20/31  (65 %)   inliers  5
//     ── téléphone de Nikos              (67 %)  inliers 1-6
//
// Le flou domine. La dernière ligne reproduit le terrain à un point près.
//
// ⚠️ MAIS UN SEUIL DE NETTETÉ ABSOLU NE MARCHERA PAS — mesuré, pas supposé. La variance du
// laplacien sur 10 photos du corpus donne : nettes 3012 / 4197 / 6529 (min/méd/max), floutées
// à 3 sigma 1760 / 2448 / 4204. La photo NETTE la moins texturée tombe SOUS la photo FLOUE la
// plus texturée : la mesure dépend autant de l'illustration que de la mise au point. Un
// `MIN_SHARPNESS` global rejetterait des cartes nettes à fond sobre. Il faut une mesure
// RELATIVE — comparer une image au maximum récemment observé sur la même carte, et déclencher
// au sommet — ou traiter la cause côté objectif.
//
// À savoir aussi : le contrôle de netteté existant (MIN_SHARPNESS, index.html) vit dans le
// worker OCR de la V1 et n'est JAMAIS traversé par le chemin V2. Le commentaire qui le
// présente comme « le filet de sécurité » est périmé depuis que la V2 tient la caméra.
