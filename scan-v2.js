// ═══════════════════════════════════════════════════════════════════════════════
// Scanner V2 (bêta) — identification par l'illustration, pas par le numéro.
//
// Chaîne : DINOv2 (embedding) cadre une shortlist sur tout le set → ORB + RANSAC la
// reclasse sur ses inliers → l'OCR départage seulement en cas de doute. Mesuré au banc
// (bench-vision.html) et sur photos réelles : ~90-97 % de rang 1 contre ~64 % pour l'OCR
// du numéro, sans jamais dépendre d'un chiffre lisible.
//
// L'index de référence (embeddings + descripteurs ORB des illustrations officielles) est
// téléchargé en pack précalculé — le téléphone ne fait AUCUNE inférence de référence.
//
// Module autonome : ses propres Workers, aucune dépendance à index.html sauf le bloc de
// parsing du numéro (extrait à l'exécution pour rester synchronisé avec la prod).
// ═══════════════════════════════════════════════════════════════════════════════

const CARD_RATIO = 88 / 63;
const ZONE_ILLUSTRATION = { x: 0.07, y: 0.11, w: 0.86, h: 0.43 };
const BANDE = { y: 0.83, h: 0.17, zoom: 2 };
const SHORT = 30;      // largeur de shortlist embedding → ORB. Remonté de 12 : à 12, la bonne
                      // carte tombait hors shortlist ~1 fois sur 8 → faux positif à basse
                      // confiance. Coûte ~300 ms de plus, la fiabilité les vaut.
const TIEBREAK = 8;    // profondeur où l'OCR peut départager
const INLIERS_MIN = 10; // en dessous, ORB n'a PAS confirmé géométriquement : on ne devine pas
// Centre de l'illustration (fractions de carte) : c'est CE point que l'autofocus doit
// viser en V2, pas la bande du numéro. Exporté pour index.html.
export const CENTRE_ILLUSTRATION = { u: 0.5, v: 0.32 };
const MODELE = 'onnx-community/dinov2-small';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0';
const OCR_MODULE   = 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@6.4.1/web/+esm';
const OPENCV       = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js';
const OCR_DICT     = 'https://cdn.jsdelivr.net/gh/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models@main/recognition/ppocrv6_tiny_dict.txt';

// ─────────────────────────────── utilitaires image
const dimW = s => s.naturalWidth || s.videoWidth || s.width;
const dimH = s => s.naturalHeight || s.videoHeight || s.height;
function versCanvas(source, zone) {
  const c = document.createElement('canvas');
  const W = dimW(source), H = dimH(source);
  if (zone) {
    c.width = Math.round(W * zone.w); c.height = Math.round(H * zone.h);
    c.getContext('2d').drawImage(source, W * zone.x, H * zone.y, W * zone.w, H * zone.h, 0, 0, c.width, c.height);
  } else { c.width = W; c.height = H; c.getContext('2d').drawImage(source, 0, 0); }
  return c;
}
const versDataUrl = (s, z) => versCanvas(s, z).toDataURL('image/jpeg', 0.92);
function bandeBasse(carte) {
  const W = carte.width, H = carte.height, sh = Math.round(H * BANDE.h), sy = Math.round(H * BANDE.y);
  const c = document.createElement('canvas');
  c.width = Math.round(W * BANDE.zoom); c.height = Math.round(sh * BANDE.zoom);
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(carte, 0, sy, W, sh, 0, 0, c.width, c.height);
  return c;
}
const cosinus = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function chargerImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => i.naturalWidth ? res(i) : rej(new Error('image vide'));
    i.onerror = () => rej(new Error('image non chargée')); i.src = src; });
}

// ─────────────────────────────── plomberie Worker
function faireWorker(src, type) {
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), type ? { type } : undefined);
  const pending = new Map(); let seq = 0;
  w.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error)); };
  w.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker KO')); pending.clear(); };
  return {
    call: (payload, transfer) => new Promise((resolve, reject) => { const id = ++seq;
      pending.set(id, { resolve, reject }); w.postMessage(Object.assign({ id }, payload), transfer || []); }),
    terminate: () => { try { w.terminate(); } catch (e) {} },
  };
}
let ocr = null, emb = null, orb = null;

function demarrerOcr(parsing) {
  ocr = faireWorker(`
    import { PaddleOcrService } from ${JSON.stringify(OCR_MODULE)};
    ${parsing}
    let svc=null,p=null;
    async function ensure(){ if(svc) return svc; if(!p) p=(async()=>{ const s=new PaddleOcrService({model:{charactersDictionary:${JSON.stringify(OCR_DICT)}}}); await s.initialize(); svc=s; })(); return p; }
    self.onmessage = async e => { const {id, bitmap} = e.data;
      try{ const s=await ensure(); const cv=new OffscreenCanvas(bitmap.width,bitmap.height);
        cv.getContext('2d').drawImage(bitmap,0,0); bitmap.close();
        const r=await s.recognize(cv,{noCache:true});
        postMessage({id, ok:true, text:(r&&r.text)||'', cands:extractNumbers((r&&r.text)||'')});
      }catch(err){ postMessage({id, ok:false, error:String(err&&err.message||err)}); } };
  `, 'module');
}
const ocrLire = async canvas => { const bmp = await createImageBitmap(canvas); return ocr.call({ bitmap: bmp }, [bmp]); };

function demarrerEmb() {
  emb = faireWorker(`
    import { pipeline, env } from ${JSON.stringify(TRANSFORMERS)};
    env.allowLocalModels = false;
    let ex=null,p=null,moteur='?';
    async function ensure(){ if(p) return p; p=(async()=>{
      const essais = [ {device:'webgpu', dtype:'fp16'}, {device:'wasm', dtype:'q8'}, {dtype:'fp32'} ];
      for(const opt of essais){
        try{ ex = await pipeline('image-feature-extraction', ${JSON.stringify(MODELE)}, opt);
             moteur = (opt.device||'wasm') + '/' + opt.dtype; return; }catch(e){}
      }
      throw new Error('aucun moteur d\\'inférence');
    })(); return p; }
    self.onmessage = async e => { const {id, dataUrl, type} = e.data;
      try{ await ensure();
        if(type==='warm'){ postMessage({id, ok:true, moteur}); return; }
        const o=await ex(dataUrl); let v=Float32Array.from(o.data);
        const d=o.dims||[]; if(d.length===3 && d[1]>1) v=v.slice(0,d[2]);
        let n=0; for(let i=0;i<v.length;i++) n+=v[i]*v[i]; n=Math.sqrt(n)||1;
        for(let i=0;i<v.length;i++) v[i]/=n;
        postMessage({id, ok:true, v, moteur}, [v.buffer]);
      }catch(err){ postMessage({id, ok:false, error:String(err&&err.message||err)}); } };
  `, 'module');
}
const embed = dataUrl => emb.call({ dataUrl });

function demarrerOrb() {
  orb = faireWorker(`
    self.cv = undefined;
    importScripts(${JSON.stringify(OPENCV)});
    let p=null;
    async function ensure(){ if(p) return p; p=(async()=>{
      if(cv instanceof Promise) cv=await cv;
      else if(typeof cv==='function') cv=await cv();
      else if(!cv.Mat) await new Promise(r=>{cv.onRuntimeInitialized=r;});
    })(); return p; }
    const NFQ=480;   // points d'intérêt de la REQUÊTE (les réfs restent à 700)
    const refs=new Map();
    function grisDepuis(b){
      const c=new OffscreenCanvas(b.width,b.height); const x=c.getContext('2d',{willReadFrequently:true});
      x.drawImage(b,0,0); b.close();
      const m=cv.matFromImageData(x.getImageData(0,0,c.width,c.height)); const g=new cv.Mat();
      cv.cvtColor(m,g,cv.COLOR_RGBA2GRAY); m.delete(); return g;
    }
    const matDeBitmap = bmp => Promise.resolve(grisDepuis(bmp));
    function detecte(g, n){ const o=new cv.ORB(n||700); const kp=new cv.KeyPointVector(); const des=new cv.Mat();
      const nm=new cv.Mat(); o.detectAndCompute(g,nm,kp,des);
      const pts=[]; for(let i=0;i<kp.size();i++){ const pp=kp.get(i).pt; pts.push({x:pp.x,y:pp.y}); }
      kp.delete(); o.delete(); nm.delete(); return {des, kp:pts}; }
    function matDepuisBytes(bytes, rows){ const m=new cv.Mat(rows,32,cv.CV_8U); m.data.set(bytes); return m; }
    function correspondances(bf, qdes, qkp, r){
      const s=[], d=[];
      if(qdes.rows>=8 && r.des.rows>=8){
        const knn=new cv.DMatchVectorVector();
        try{ bf.knnMatch(qdes, r.des, knn, 2);
          for(let i=0;i<knn.size();i++){ const pr=knn.get(i); if(pr.size()<2) continue;
            const m0=pr.get(0), m1=pr.get(1);
            if(m0.distance < 0.75*m1.distance){ s.push(qkp[m0.queryIdx].x, qkp[m0.queryIdx].y); d.push(r.kp[m0.trainIdx].x, r.kp[m0.trainIdx].y); } }
        }catch(e){} knn.delete();
      }
      return {s, d, good: s.length/2};
    }
    function inliers(s, d, good){
      if(good < 8) return good*0.1;
      const ms=cv.matFromArray(good,1,cv.CV_32FC2,s), md=cv.matFromArray(good,1,cv.CV_32FC2,d);
      const mk=new cv.Mat(); let n=0;
      try{ const H=cv.findHomography(ms,md,cv.RANSAC,5,mk); for(let i=0;i<mk.rows;i++) n+=mk.data[i]; H.delete(); }catch(e){ n=good*0.1; }
      ms.delete(); md.delete(); mk.delete(); return n;
    }
    self.onmessage = async e => {
      const {id, type, cle, cles, bitmap, bytes, rows, kp} = e.data;
      try{ await ensure();
        if(type==='warm'){ const g=cv.Mat.zeros(200,140,cv.CV_8U); detecte(g,120).des.delete(); g.delete(); postMessage({id, ok:true}); return; }
        if(type==='refImport'){ if(refs.has(cle)) refs.get(cle).des.delete();
          refs.set(cle,{des:matDepuisBytes(bytes, rows), kp}); postMessage({id, ok:true}); return; }
        if(type==='clear'){ for(const r of refs.values()) r.des.delete(); refs.clear(); postMessage({id, ok:true}); return; }
        if(type==='dropSet'){ for(const c of cles){ const r=refs.get(c); if(r){ r.des.delete(); refs.delete(c); } } postMessage({id, ok:true, restants:refs.size}); return; }
        if(type==='querySubset'){
          const g = await matDeBitmap(bitmap);
          const {des:qd, kp:qk}=detecte(g, NFQ); g.delete();
          const bf=new cv.BFMatcher(cv.NORM_HAMMING,false);
          const cibles = cles.filter(c=>refs.has(c));
          const pre = cibles.map(rc => ({cle:rc, ...correspondances(bf, qd, qk, refs.get(rc))})).sort((a,b)=> b.good - a.good);
          // Homographie RANSAC sur les 16 meilleurs candidats par nombre de correspondances
          // (au lieu de 6) : à 6, la bonne carte classée 7e-12e sur le nombre brut ne
          // recevait jamais de vraie vérification géométrique et perdait contre un faux.
          const out = pre.map((p,i) => ({ cle: p.cle, good: p.good,
            score: (i < 16 && p.good >= 8) ? inliers(p.s, p.d, p.good) : p.good*0.1 }));
          bf.delete(); qd.delete(); out.sort((a,b)=>b.score-a.score);
          postMessage({id, ok:true, out}); return;
        }
      }catch(err){ postMessage({id, ok:false, error:String(err&&err.message||err)}); }
    };
  `);
}

// ─────────────────────────────── extraction du parsing OCR depuis index.html
async function chargerParsing() {
  const res = await fetch('index.html?nocache=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('index.html introuvable');
  const html = await res.text();
  const a = html.indexOf('const LOOKALIKES =');
  const b = html.indexOf('// Netteté : variance du laplacien');
  if (a < 0 || b < 0) throw new Error('bloc de parsing introuvable');
  const resolved = new Function('return `' + html.slice(a, b) + '`')();
  if (!/function extractNumbers/.test(resolved)) throw new Error('extractNumbers absent');
  return resolved;
}

// ─────────────────────────────── index global + packs ORB à la demande
//
// L'utilisateur ne choisit JAMAIS de set. Au démarrage on télécharge une seule fois un
// index d'empreintes qui couvre toute la tranche du catalogue (~8 Mo, gardé en IndexedDB).
// Les descripteurs ORB, eux, sont lourds : on ne récupère le pack d'un set QUE quand une
// carte de ce set apparaît dans la shortlist d'un scan, et on le garde en cache.
const R2 = 'https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev';
const MAX_SETS_ORB = 6;                 // packs ORB gardés en mémoire du worker (LRU)
const nomPack = setId => String(setId).replace(/[^\w.-]/g, '_');

// —— petit cache IndexedDB (l'index global et les packs y vivent « pour toujours »)
const IDB_NOM = 'pokescan_v2', IDB_STORE = 'blobs';
let _db = null;
function idb() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NOM, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
async function idbGet(k) {
  try { const db = await idb(); return await new Promise((res) => { const t = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); }
  catch (e) { return null; }
}
async function idbSet(k, v) {
  try { const db = await idb(); await new Promise((res) => { const t = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(v, k); t.onsuccess = res; t.onerror = res; }); } catch (e) {}
}
async function idbDelPrefixe(prefixe, sauf) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const s = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
      const cur = s.openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res();
        if (String(c.key).startsWith(prefixe) && c.key !== sauf) c.delete(); c.continue(); };
      cur.onerror = () => res();
    });
  } catch (e) {}
}

async function telechargerR2(chemin, { json, gunzip } = {}) {
  const r = await fetch(R2 + '/' + chemin, { cache: 'no-store' });
  if (!r.ok) throw new Error(chemin + ' : HTTP ' + r.status);
  let buf = await r.arrayBuffer();
  if (gunzip) {
    const u = new Uint8Array(buf);
    if (u[0] === 0x1f && u[1] === 0x8b && typeof DecompressionStream === 'function') {   // encore compressé
      const ds = new DecompressionStream('gzip');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    }
  }
  return json ? JSON.parse(new TextDecoder().decode(buf)) : buf;
}

// —— parse un pack de set (format navigateur) : n'en garde QUE l'ORB (l'embedding vient
//    déjà de l'index global) et l'injecte dans le worker.
async function injecterPackOrb(setId, buf) {
  const dv = new DataView(buf);
  const hLen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hLen)));
  let off = 4 + hLen;
  const cles = [];
  for (const c of header.cards) {
    off += header.embDim;
    const des = new Uint8Array(buf.slice(off, off + c.or * 32)); off += c.or * 32;
    const kpI16 = new Int16Array(buf.slice(off, off + c.or * 4)); off += c.or * 4;
    const kp = []; for (let i = 0; i < c.or; i++) kp.push({ x: kpI16[i * 2], y: kpI16[i * 2 + 1] });
    await orb.call({ type: 'refImport', cle: c.cle, bytes: des, rows: c.or, kp });
    cles.push(c.cle);
  }
  return cles;
}

// —— s'assure que les packs ORB des sets donnés sont chargés dans le worker (LRU).
//    Renvoie true si un téléchargement a eu lieu (le scan a été ralenti d'autant).
async function assurerPacksOrb(setIds) {
  let telecharge = false;
  for (const setId of setIds) {
    if (orbCharges.has(setId)) { orbCharges.get(setId).ts = Date.now(); continue; }
    onEtat('Chargement du set ' + setId + '…');
    let buf = await idbGet('pack:' + setId + ':' + (manifest?.updatedAt || '0'));
    if (!buf) {
      try { buf = await telechargerR2('pack-' + nomPack(setId) + '.pack'); telecharge = true; }
      catch (e) { orbCharges.set(setId, { ts: Date.now(), cles: [], absent: true }); continue; }
      idbDelPrefixe('pack:' + setId + ':');
      idbSet('pack:' + setId + ':' + (manifest?.updatedAt || '0'), buf);
    }
    const cles = await injecterPackOrb(setId, buf);
    orbCharges.set(setId, { ts: Date.now(), cles });
  }
  // éviction LRU des sets les plus anciens qu'on ne vient pas d'utiliser
  const besoin = new Set(setIds);
  while (orbCharges.size > MAX_SETS_ORB) {
    let vieux = null, vieuxTs = Infinity;
    for (const [id, v] of orbCharges) if (!besoin.has(id) && v.ts < vieuxTs) { vieux = id; vieuxTs = v.ts; }
    if (!vieux) break;
    const v = orbCharges.get(vieux);
    if (v.cles.length) { try { await orb.call({ type: 'dropSet', cles: v.cles }); } catch (e) {} }
    orbCharges.delete(vieux);
  }
  return telecharge;
}

// ─────────────────────────────── état + API publique
let BASE = [], cleToCard = new Map(), pret = false, actif = false, moteurEmb = '?';
let EMB_Q8 = null, EMB_DIM = 384;
let manifest = null;
let onEtat = () => {};
const orbCharges = new Map();   // setId -> { ts, cles:[...], absent? }

export function pretV2() { return pret; }
export function actifV2() { return pret && actif; }
export function basculerV2(on) { actif = !!on; }
export function moteurV2() { return moteurEmb; }
export function setV2() { return [...orbCharges.keys()]; }
export function trancheV2() { return manifest?.slice || null; }
export function surEtatV2(cb) { onEtat = typeof cb === 'function' ? cb : (() => {}); }

// Initialise V2 : télécharge (une fois) l'index d'empreintes global, démarre les moteurs.
// Aucun set à préciser — l'index couvre toute la tranche.
export async function initV2(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  pret = false;

  if (!emb) demarrerEmb();
  if (!orb) demarrerOrb();

  onProgress(0.02, 'Manifeste…');
  manifest = await telechargerR2('manifest.json', { json: true });
  if (manifest.model && manifest.model !== MODELE) throw new Error('index pour un autre modèle (' + manifest.model + ')');
  const version = manifest.updatedAt || '0';

  onProgress(0.05, 'Index visuel…');
  const cleIdx = 'idx:' + version;
  let bin = await idbGet(cleIdx);
  let meta = await idbGet('meta:' + version);
  if (!bin || !meta) {
    bin = await telechargerR2('index-global.bin');
    meta = await telechargerR2('index-global-meta.json.gz', { json: true, gunzip: true });
    idbDelPrefixe('idx:', cleIdx); idbDelPrefixe('meta:', 'meta:' + version);
    idbSet(cleIdx, bin); idbSet('meta:' + version, meta);
  }

  onProgress(0.55, 'Décodage…');
  const dv = new DataView(bin);
  const count = dv.getUint32(0, true), embDim = dv.getUint32(4, true);
  EMB_DIM = embDim;
  // On garde les embeddings quantifiés int8 (2× moins de mémoire que du float32 pour
  // ~8 000 cartes) + un facteur inv = 1/(127·‖v‖) par carte : le cosinus se ramène alors
  // à un produit scalaire d'entiers × inv, la requête étant déjà normalisée L2.
  const q8 = new Int8Array(bin.slice(8, 8 + count * embDim));
  BASE = new Array(count);
  for (let i = 0; i < count; i++) {
    let n = 0; for (let j = 0; j < embDim; j++) { const v = q8[i * embDim + j]; n += v * v; }
    const inv = 1 / (Math.sqrt(n) || 1);
    const m = meta[i];
    BASE[i] = { cle: m.c, numero: m.n, setId: m.s, name: m.m, image: m.i,
                localId: String(m.c).slice(String(m.s).length + 1), off: i * embDim, inv };
  }
  EMB_Q8 = q8;
  cleToCard = new Map(BASE.map(c => [c.cle, c]));

  onProgress(0.8, 'OCR…');
  try { demarrerOcr(await chargerParsing()); } catch (e) { /* OCR optionnel */ }

  onProgress(0.9, 'Préchauffage…');
  const warm = document.createElement('canvas'); warm.width = 140; warm.height = 196;
  warm.getContext('2d').fillRect(0, 0, 140, 196);
  const [m] = await Promise.all([
    embed(versDataUrl(warm, null)).then(r => r.moteur).catch(() => '?'),
    orb.call({ type: 'warm' }).catch(() => {}),
    ocr ? ocrLire(warm).catch(() => {}) : null,
  ]);
  moteurEmb = m;
  pret = true;
  onProgress(1, `V2 prête — ${BASE.length} cartes, ${manifest.sets ? Object.keys(manifest.sets).length : '?'} sets (${m}).`);
  return { cartes: BASE.length, moteur: m };
}

// Identifie une carte déjà redressée (canvas). Renvoie pick + fiabilité + catégorie.
export async function identifierV2(carte) {
  if (!pret) throw new Error('V2 pas prête');
  const T = {};
  const chrono = async (k, p) => { const t = performance.now(); const r = await p; T[k] = Math.round(performance.now() - t); return r; };

  // 1. embedding → shortlist
  const petit = document.createElement('canvas'); petit.width = 320; petit.height = Math.round(320 * CARD_RATIO);
  petit.getContext('2d').drawImage(carte, 0, 0, petit.width, petit.height);
  const e = await chrono('emb', embed(versDataUrl(petit, ZONE_ILLUSTRATION)));
  const ev = e.v, q8 = EMB_Q8, D = EMB_DIM;
  const parEmb = BASE.map(c => {
    let s = 0; const o = c.off;
    for (let j = 0; j < D; j++) s += q8[o + j] * ev[j];
    return { cle: c.cle, s: s * c.inv };
  }).sort((a, b) => b.s - a.s);
  const embTop = parEmb[0].s;
  const court = parEmb.slice(0, SHORT).map(x => x.cle);

  // 2. packs ORB des sets de la shortlist (téléchargés à la demande, puis en cache)
  const setsCourt = [...new Set(court.map(cle => cleToCard.get(cle).setId))];
  let packTelecharge = false;
  try { packTelecharge = await chrono('packs', assurerPacksOrb(setsCourt)); } catch (err) {}
  onEtat('');

  // 3. ORB reclasse la shortlist
  let ranked = court, orbScores = {};
  try {
    const bmp = await createImageBitmap(carte);
    const rr = await chrono('orb', orb.call({ type: 'querySubset', bitmap: bmp, cles: court }, [bmp]));
    ranked = rr.out.map(o => o.cle);
    rr.out.forEach(o => (orbScores[o.cle] = o.score));
  } catch (err) {}

  let pick = ranked[0];
  let inl = orbScores[pick] || 0;
  const second = ranked.find(c => c !== pick);
  let marge = inl - (orbScores[second] || 0);
  const dominance0 = inl > 0 ? marge / inl : 0;
  const orbFranc = inl >= 18 && dominance0 >= 0.6;

  // 4. OCR — en cas de doute réel (ORB pas franc). C'est le garde-fou contre le faux
  //    positif : quand ORB hésite, un numéro lu qui pointe vers un candidat de la shortlist
  //    tranche ; sinon la carte reste « douteuse » et l'utilisateur confirme.
  let ocrCands = [], ocrTxt = '', ocrLance = false;
  if (ocr && !orbFranc) {
    ocrLance = true;
    try { const r = await chrono('ocr', ocrLire(bandeBasse(carte))); ocrCands = r.cands || []; ocrTxt = r.text || ''; } catch (e) {}
    if (ocrCands.length) {
      const nums = new Set(ocrCands.map(c => c.number));
      const hit = ranked.slice(0, TIEBREAK).find(cle => nums.has(cleToCard.get(cle).numero));
      if (hit) { pick = hit; inl = orbScores[pick] || 0; marge = inl - (orbScores[second] || 0); }
    }
  }

  const cible = pick && cleToCard.get(pick);
  const ocrOk = !!cible && ocrCands.some(c => c.number === cible.numero);
  const dom = inl > 0 ? marge / inl : 0;
  const x = 0.05 * inl + 3.2 * dom + (ocrOk ? 1.5 : 0) - 2.4;
  const fiabilite = Math.round(Math.max(5, Math.min(99, 100 / (1 + Math.exp(-x)))));

  // Prétri. « rebut » = pas d'identification exploitable : ORB n'a pas confirmé
  // géométriquement (< INLIERS_MIN inliers) ET l'OCR n'a pas non plus pointé vers une carte.
  // Dans ce cas on préfère « non identifiée, re-scanne » à une carte fausse.
  let categorie;
  if (!pick || (inl < INLIERS_MIN && !ocrOk)) categorie = 'rebut';
  else if (fiabilite >= 80 || ocrOk) categorie = 'sure';
  else categorie = 'douteuse';

  return {
    pick: cible ? { cle: cible.cle, numero: cible.numero, name: cible.name, setId: cible.setId, localId: cible.localId, image: cible.image } : null,
    fiabilite, categorie, inliers: Math.round(inl), marge: Math.round(marge), embTop, ocrTxt, ocrLance, ocrOk,
    packTelecharge, setsCharges: [...orbCharges.keys()],
    ms: Object.values(T).reduce((a, b) => a + b, 0), T, moteur: moteurEmb,
    alts: ranked.slice(0, 8).map(cle => { const c = cleToCard.get(cle); return { cle, numero: c.numero, name: c.name, image: c.image, localId: c.localId, inliers: Math.round(orbScores[cle] || 0) }; }),
  };
}

// ─────────────────────────────── relais des résultats (mêmes logs que l'outil de test)
function idAppareil() {
  let v; try { v = localStorage.getItem('scan_device'); } catch (e) {}
  if (!v) { v = Math.random().toString(36).slice(2, 8); try { localStorage.setItem('scan_device', v); } catch (e) {} }
  return v;
}
export async function relayV2(entries) {
  const liste = Array.isArray(entries) ? entries : [entries];
  try {
    const r = await fetch('/api/scan-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: idAppareil(), outil: 'v2-prod', entries: liste }),
    });
    return r.ok;
  } catch (e) { return false; }
}
