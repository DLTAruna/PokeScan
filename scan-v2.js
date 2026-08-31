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
const SHORT = 12;      // largeur de shortlist embedding → ORB (12 : ORB reste ~2× plus rapide qu'à 18 sur mobile)
const TIEBREAK = 6;    // profondeur où l'OCR peut départager
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
    const NFQ=320;   // points d'intérêt de la REQUÊTE (les réfs restent à 700) — 320 suffit et va plus vite
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
        if(type==='querySubset'){
          const g = await matDeBitmap(bitmap);
          const {des:qd, kp:qk}=detecte(g, NFQ); g.delete();
          const bf=new cv.BFMatcher(cv.NORM_HAMMING,false);
          const cibles = cles.filter(c=>refs.has(c));
          const pre = cibles.map(rc => ({cle:rc, ...correspondances(bf, qd, qk, refs.get(rc))})).sort((a,b)=> b.good - a.good);
          const out = pre.map((p,i) => ({ cle: p.cle, good: p.good,
            score: (i < 6 && p.good >= 10) ? inliers(p.s, p.d, p.good) : p.good*0.1 }));
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

// ─────────────────────────────── pack précalculé
const nomPack = setId => String(setId).replace(/[^\w.-]/g, '_');
async function chargerDepuisPack(buf, onProgress) {
  const dv = new DataView(buf);
  const hLen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hLen)));
  if (header.model !== MODELE) throw new Error('pack pour un autre modèle');
  let off = 4 + hLen;
  const cartes = [];
  for (let ci = 0; ci < header.cards.length; ci++) {
    const c = header.cards[ci];
    const embI8 = new Int8Array(buf.slice(off, off + header.embDim)); off += header.embDim;
    const des = new Uint8Array(buf.slice(off, off + c.or * 32)); off += c.or * 32;
    const kpI16 = new Int16Array(buf.slice(off, off + c.or * 4)); off += c.or * 4;
    const vec = new Float32Array(header.embDim);
    let n = 0; for (let i = 0; i < header.embDim; i++) { vec[i] = embI8[i] / 127; n += vec[i] * vec[i]; }
    n = Math.sqrt(n) || 1; for (let i = 0; i < header.embDim; i++) vec[i] /= n;
    const kp = []; for (let i = 0; i < c.or; i++) kp.push({ x: kpI16[i * 2], y: kpI16[i * 2 + 1] });
    const localId = c.cle.slice(header.set.length + 1);
    cartes.push({ cle: c.cle, numero: c.num, setId: header.set, localId, image: c.img, name: c.name, vec, _des: des, _rows: c.or, _kp: kp });
  }
  for (let i = 0; i < cartes.length; i++) {
    const c = cartes[i];
    await orb.call({ type: 'refImport', cle: c.cle, bytes: c._des, rows: c._rows, kp: c._kp });
    delete c._des; delete c._rows; delete c._kp;
    if (onProgress && i % 12 === 0) onProgress(i / cartes.length);
  }
  return cartes;
}

// ─────────────────────────────── état + API publique
let BASE = [], cleToCard = new Map(), pret = false, actif = false, moteurEmb = '?', setCourant = null;

export function pretV2() { return pret; }            // l'index est chargé
export function actifV2() { return pret && actif; }  // ...ET l'utilisateur a activé le scan V2
export function basculerV2(on) { actif = !!on; }
export function moteurV2() { return moteurEmb; }
export function setV2() { return setCourant; }

// Initialise (ou réinitialise) V2 pour un set : télécharge le pack, démarre les moteurs.
export async function initV2(setId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  pret = false; setCourant = null;
  if (!setId) throw new Error('aucun set verrouillé — verrouille un set pour V2');

  if (!emb) demarrerEmb();
  if (orb) { try { await orb.call({ type: 'clear' }); } catch (e) {} } else demarrerOrb();

  onProgress(0.02, 'Téléchargement de l\'index…');
  const urls = [
    'packs/' + nomPack(setId) + '.pack',
    '/api/pack?set=' + encodeURIComponent(nomPack(setId)),
  ];
  let buf = null;
  for (const u of urls) {
    try { const r = await fetch(u, { cache: 'force-cache' }); if (r.ok) { const b = await r.arrayBuffer(); if (b.byteLength > 500) { buf = b; break; } } } catch (e) {}
  }
  if (!buf) throw new Error('pas de pack pour ' + setId + ' — ouvre-le une fois dans le scanner de test pour le générer');

  BASE = await chargerDepuisPack(buf, p => onProgress(0.05 + 0.7 * p, 'Chargement de l\'index…'));
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
  setCourant = setId;
  pret = true;
  onProgress(1, `V2 prête — ${BASE.length} cartes (${m}).`);
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
  const parEmb = BASE.map(c => ({ cle: c.cle, s: cosinus(e.v, c.vec) })).sort((a, b) => b.s - a.s);
  const embTop = parEmb[0].s;
  const court = parEmb.slice(0, SHORT).map(x => x.cle);

  // 2. ORB reclasse la shortlist
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

  // 3. OCR — quasiment jamais en live V2 : sur photos réelles il n'a jamais départagé quoi
  //    que ce soit et coûte ~1 s. On ne le lance QUE si ORB n'a strictement rien trouvé
  //    (moins de 6 inliers partout) — dernier filet, pas un étage régulier.
  let ocrCands = [], ocrTxt = '', ocrLance = false;
  if (ocr && inl < 6) {
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
  const x = 0.05 * inl + 3.2 * dom + (ocrOk ? 1.2 : 0) - 2.4;
  const fiabilite = Math.round(Math.max(5, Math.min(99, 100 / (1 + Math.exp(-x)))));

  const meilleurAlt = ranked.length > 1 ? (orbScores[ranked[1]] || 0) : 0;
  let categorie;
  if (!pick || (inl < 3 && embTop < 0.42 && meilleurAlt < 3)) categorie = 'rebut';
  else if (fiabilite >= 82) categorie = 'sure';
  else categorie = 'douteuse';

  return {
    pick: cible ? { cle: cible.cle, numero: cible.numero, name: cible.name, setId: cible.setId, localId: cible.localId, image: cible.image } : null,
    fiabilite, categorie, inliers: Math.round(inl), marge: Math.round(marge), embTop, ocrTxt, ocrLance, ocrOk,
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
