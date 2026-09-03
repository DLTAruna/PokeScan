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
// ─── Réglages de la chaîne, en un seul endroit et MODIFIABLES À CHAUD (reglagesV2).
// Le banc (bench-v2.html) les pilote pour comparer deux configurations sur le même corpus.
// Ils restent des valeurs de production : le banc joue le module qui tourne sur le
// téléphone, pas une copie — une copie dérive, et on finirait par régler un scanner qui
// n'existe pas.
const R = {
  SHORT: 18,          // largeur de shortlist embedding → ORB. 12 laissait la bonne carte
                      // dehors ~1 fois sur 8 ; 30 faisait télécharger 30 blobs/scan sur un
                      // classeur varié. 18 : recall quasi intact (rang médian 0, p90 0 au
                      // banc sur 7 591 cartes), 40 % de blobs en moins.
  TIEBREAK: 8,        // profondeur où l'OCR peut départager
  INLIERS_MIN: 10,    // en dessous, ORB n'a PAS confirmé géométriquement : on ne devine pas
  OCR_INLIERS_MIN: 25, // l'OCR ne sert qu'à départager une égalité : beaucoup d'inliers…
  OCR_DOM_MAX: 0.6,    // …mais un 2e candidat au coude à coude. Voir l'étape 4.
  OCR_MARGE_MAX: 35,   // …et un coude-à-coude EN ABSOLU, pas seulement en proportion.
  OCR_ORB_MS_MAX: 1800, // session chaude (dernier ORB au-delà) → on ne lance pas l'OCR
  // ─── Le SECOURS PAR LE NOM. L'OCR ci-dessus ne sert qu'à départager deux candidats déjà
  // solides : il exige inl ≥ OCR_INLIERS_MIN, donc il ne se déclenche JAMAIS sur un échec.
  // Par construction, il ne pouvait rien rattraper. Celui-ci fait l'inverse : il n'intervient
  // que lorsque l'appariement a échoué, et il lit le NOM plutôt que le numéro.
  //
  // Mesuré sur les 31 photos de référence : 24 noms lus sur 31 (77 %), en 471 ms médians.
  // Les échecs se trompent d'une lettre — « Carabatte » pour Carabaffe, « Rentincel » pour
  // Reptincel — d'où la comparaison tolérante : à deux lettres près on retrouve la carte,
  // ce qui porte le taux autour de 87 %. Le nom n'a pas à être lu juste, il a seulement à
  // désigner un candidat parmi dix-huit.
  //
  // Le numéro, lui, est la chose la plus dure à lire de toute la carte : la bande basse rend
  // le texte de description avant de rendre le numéro. C'est ce qui expliquait le 0/28 des
  // essais de secours précédents — on visait la mauvaise cible.
  NOM_ACTIF: true,
  NOM_INLIERS_MAX: 20,  // au-dessus, l'appariement se suffit à lui-même
  NOM_ECART_MAX: 2,     // lettres de différence tolérées
  NOM_CANDIDATS: 24,    // candidats issus de l'appariement, fouillés d'abord
  NOM_PROFONDEUR: 500,  // …puis le classement par empreinte, bien plus loin
  ORB_PREMIER: 6,      // candidats appariés au premier passage (voir l'ORB en deux temps)
  GEO_INLIERS: 20,     // géométrie franche → « sûre » même si la sigmoïde reste basse
  GEO_DOM: 0.6,
  MAX_CARTES_ORB: 900, // descripteurs gardés en mémoire du worker (LRU, ~23 Mo)
  RECYCLE_ORB: 12,     // scans entre deux recyclages du worker ORB (filet de sécurité)
  ORB_MAX_REFS: 60,    // descripteurs gardés dans le worker. Trois shortlists de 18 : de quoi
                       // enchaîner sans retélécharger, sans laisser le tas WASM gonfler.
  WORKER_ORB: 'https://pokescan-orb.inox62.workers.dev', // null → une requête R2 par carte
};
// Lecture seule sans argument ; avec un objet, applique le patch et renvoie l'état obtenu.
// Réservé au banc et au diagnostic — la production ne l'appelle jamais.
export function reglagesV2(patch) { if (patch) Object.assign(R, patch); return { ...R }; }
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
// La bande du NOM : en haut de la carte redressée, grands caractères sur fond franc. Sept
// cent vingt pixels de large suffisent — au-delà l'OCR ralentit sans mieux lire, en deçà les
// accents se perdent.
const BANDE_NOM = { y: 0.035, h: 0.11, large: 720 };
function bandeHaute(carte) {
  const W = carte.width, H = carte.height;
  const sy = Math.round(H * BANDE_NOM.y), sh = Math.round(H * BANDE_NOM.h);
  const c = document.createElement('canvas');
  c.width = BANDE_NOM.large;
  c.height = Math.max(24, Math.round(BANDE_NOM.large * sh / W));
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(carte, 0, sy, W, sh, 0, 0, c.width, c.height);
  return c;
}

// Accents, casse et ponctuation retirés : l'OCR rend « DracaufeueX » là où le catalogue dit
// « Dracaufeu-ex », et ces deux-là désignent la même carte.
function nomNormalise(t) {
  return String(t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Distance de Levenshtein bornée : on n'a pas besoin de la valeur exacte, seulement de
// savoir si elle dépasse le seuil. Sortir tôt évite de comparer des mots sans rapport.
function ecartMots(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prec = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cour = [i];
    let mini = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cour[j] = v; if (v < mini) mini = v;
    }
    if (mini > max) return max + 1;
    prec = cour;
  }
  return prec[b.length];
}

// Le nom du catalogue apparaît-il dans ce que l'OCR a rendu ? On cherche d'abord tel quel,
// puis à deux lettres près sur chaque fenêtre de la bonne longueur — c'est ce qui rattrape
// « Carabatte » pour Carabaffe.
// La tolérance doit suivre la LONGUEUR du nom, et c'est un correctif, pas un raffinement.
// Avec deux lettres d'écart accordées à tout le monde, « Natu » — quatre lettres — a été
// retenu sur un texte qui disait « Carapuce » : « capu » est à deux éditions de « natu ».
// Une identification fausse est pire qu'un rebut, puisqu'elle ne se signale pas. Un nom
// court doit donc être lu exactement ; seuls les longs, où l'OCR se trompe d'une lettre
// sans ambiguïté possible, méritent de la marge.
function marge(nom) { const n = nomNormalise(nom).length; return n <= 4 ? 0 : n <= 7 ? 1 : 2; }
function nomTrouve(texteOcr, nomCarte, plafond) {
  const max = Math.min(plafond, marge(nomCarte));
  const t = nomNormalise(texteOcr), n = nomNormalise(nomCarte);
  if (n.length < 4 || !t) return false;
  if (max === 0) { const r = nomNormalise(String(nomCarte).split(/[-s]/)[0]);
    return t.includes(n) || (r.length >= 4 && t.includes(r)); }
  if (t.includes(n)) return true;
  const racine = nomNormalise(String(nomCarte).split(/[-\s]/)[0]);
  const cible = racine.length >= 4 ? racine : n;
  if (t.includes(cible)) return true;
  const L = cible.length;
  for (let i = 0; i + L - max <= t.length; i++)
    for (let d = -max; d <= max; d++) {
      const bout = t.substr(i, L + d);
      if (bout.length >= 4 && ecartMots(bout, cible, max) <= max) return true;
    }
  return false;
}

const cosinus = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function chargerImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => i.naturalWidth ? res(i) : rej(new Error('image vide'));
    i.onerror = () => rej(new Error('image non chargée')); i.src = src; });
}

// ─────────────────────────────── plomberie Worker
// ⚠️ TOUT APPEL DOIT FINIR PAR SE RÉSOUDRE OU ÉCHOUER (durci en V.25).
// La version d'avant créait une promesse et l'oubliait dans `pending` : elle ne se réglait
// que sur `onmessage` ou `onerror`. Deux chemins la laissaient donc en suspens POUR TOUJOURS :
//   • `terminate()` — appelé par `recyclerOrb()` tous les RECYCLE_ORB scans. Un appel en vol
//     à cet instant n'était ni résolu ni rejeté, et `w.onerror` ne se déclenche pas sur une
//     terminaison volontaire ;
//   • un worker tué par le système (mémoire) sans émettre d'erreur exploitable.
// Conséquence en cascade, constatée par Nikos : `identifierV2` ne rend jamais la main →
// `gererScanV2` non plus → le `finally` de `attemptReadV2` ne s'exécute pas → `readInFlight`
// reste vrai → et depuis la V.16 la boucle de détection sort immédiatement tant qu'il l'est.
// Le cadre se fige et plus rien n'est scannable, définitivement.
const APPEL_WORKER_MS_MAX = 20000;   // au-delà, ce n'est plus de la lenteur, c'est une perte
function faireWorker(src, type) {
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), type ? { type } : undefined);
  const pending = new Map(); let seq = 0;
  const regler = (id, fn) => { const p = pending.get(id); if (p) { pending.delete(id); clearTimeout(p.minuteur); fn(p); } };
  w.onmessage = e => regler(e.data.id, p => e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error)));
  w.onerror = e => { for (const id of [...pending.keys()]) regler(id, p => p.reject(new Error(e.message || 'worker KO'))); };
  return {
    call: (payload, transfer) => new Promise((resolve, reject) => {
      const id = ++seq;
      const minuteur = setTimeout(
        () => regler(id, p => p.reject(new Error('worker muet (' + (payload && payload.type || '?') + ')'))),
        APPEL_WORKER_MS_MAX);
      pending.set(id, { resolve, reject, minuteur });
      w.postMessage(Object.assign({ id }, payload), transfer || []);
    }),
    // Rejette AVANT de terminer : sinon les appels en vol restent orphelins.
    terminate: () => {
      for (const id of [...pending.keys()]) regler(id, p => p.reject(new Error('worker recyclé')));
      try { w.terminate(); } catch (e) {}
    },
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
    let ex=null,p=null,moteur='?',diag=[];
    async function ensure(){ if(p) return p; p=(async()=>{
      // fp16 sur WebGPU exige la fonctionnalité 'shader-f16', absente de beaucoup de GPU
      // mobiles → on tente d'abord fp32/q4 sur WebGPU (2-3× le CPU, sans shader-f16) AVANT
      // de retomber sur WASM. diag[] remonte la raison de chaque échec.
      let gpu=false;
      try{ gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); }catch(e){}
      diag.push('navigator.gpu='+!!(navigator.gpu)+' adapter='+gpu);
      // fp16 d'abord (le plus rapide quand le GPU le supporte — c'est le cas de beaucoup de
      // mobiles récents), puis fp32 (GPU sans shader-f16), puis q4, puis WASM.
      const essais = gpu
        ? [ {device:'webgpu',dtype:'fp16'}, {device:'webgpu',dtype:'fp32'}, {device:'webgpu',dtype:'q4'}, {device:'wasm',dtype:'q8'}, {dtype:'fp32'} ]
        : [ {device:'wasm',dtype:'q8'}, {dtype:'fp32'} ];
      for(const opt of essais){
        try{ ex = await pipeline('image-feature-extraction', ${JSON.stringify(MODELE)}, opt);
             moteur = (opt.device||'wasm') + '/' + opt.dtype; return; }
        catch(e){ diag.push((opt.device||'wasm')+'/'+opt.dtype+' KO: '+String(e&&e.message||e).slice(0,90)); }
      }
      throw new Error('aucun moteur d\\'inférence — '+diag.join(' | '));
    })(); return p; }
    self.onmessage = async e => { const {id, dataUrl, type} = e.data;
      try{ await ensure();
        if(type==='warm'){ postMessage({id, ok:true, moteur, diag}); return; }
        const o=await ex(dataUrl); let v=Float32Array.from(o.data);
        const d=o.dims||[]; if(d.length===3 && d[1]>1) v=v.slice(0,d[2]);
        let n=0; for(let i=0;i<v.length;i++) n+=v[i]*v[i]; n=Math.sqrt(n)||1;
        for(let i=0;i<v.length;i++) v[i]/=n;
        postMessage({id, ok:true, v, moteur}, [v.buffer]);
      }catch(err){ postMessage({id, ok:false, error:String(err&&err.message||err)}); } };
  `, 'module');
}
// ⚠️ SÉRIALISÉ. La session ONNX n'accepte pas deux inférences à la fois : elle rend
// « Session already started » puis « Session mismatch », et l'appel resté en vol ne se
// résout jamais — le scanner se fige sur « identification… », occupe à vrai.
// Le cas est apparu en introduisant l'empreinte prise d'avance : la spéculation pouvait
// encore tourner quand la capture lançait la sienne. Le banc l'a attrapé au premier essai.
// Une file d'un élément suffit, et ne coûte rien dans l'usage prévu — on ne veut jamais
// deux empreintes en parallèle, seulement une empreinte en parallèle de la DÉTECTION, qui
// est un autre modèle et une autre session.
let fileEmb = Promise.resolve();
const embed = (dataUrl) => {
  const suite = fileEmb.then(() => emb.call({ dataUrl }));
  // La file ne doit pas mourir sur un échec : on la relance quoi qu'il arrive.
  fileEmb = suite.then(() => {}, () => {});
  return suite;
};

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
    const NFQ=360;   // points d'intérêt de la REQUÊTE (les réfs restent à 700). Baissé de
                     // 480 : l'ORB était à 2-3 s sur téléphone modeste, il domine tout.
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
          // Homographie RANSAC sur les 8 meilleurs candidats par nombre de correspondances.
          // (16 auparavant : chaque RANSAC coûte ~150 ms, sur téléphone modeste c'était 2 s
          // rien que là. La bonne carte est quasi toujours dans les 8 premiers en brut.)
          const out = pre.map((p,i) => ({ cle: p.cle, good: p.good,
            score: (i < 8 && p.good >= 8) ? inliers(p.s, p.d, p.good) : p.good*0.1 }));
          bf.delete(); qd.delete(); out.sort((a,b)=>b.score-a.score);
          postMessage({id, ok:true, out}); return;
        }
      }catch(err){ postMessage({id, ok:false, error:String(err&&err.message||err)}); }
    };
  `);
}

// ─────────────────────────────── extraction du parsing OCR depuis index.html
async function chargerParsing() {
  const res = await fetchBorne('index.html?nocache=' + Date.now(), { cache: 'no-store' }, 15000);
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
// (Worker Cloudflare et taille du cache ORB : voir R.WORKER_ORB / R.MAX_CARTES_ORB.)

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

// `onOctets(recus, total)` : avancement RÉEL du téléchargement, en octets. Sans lui, la
// progression rapportée par initV2 sautait de 5 % à 55 % — et ce trou, c'est justement le
// gros fichier (index-global.bin, 6,8 Mo depuis que le catalogue couvre les 18 séries).
// Une barre de progression y serait restée figée pendant tout ce qui compte. On lit donc
// le corps en flux quand l'appelant veut suivre, et d'un bloc sinon (les petits fichiers).
// ⚠️ AUCUN `fetch` DE CE FICHIER NE DOIT ÊTRE SANS DÉLAI DE GARDE (V.33).
// C'est la cause du blocage signalé deux fois par Nikos : « ça scanne, ça marque recherche,
// et plus moyen de scanner ». Un `fetch` sans borne ne se règle JAMAIS si le réseau décroche
// en cours de route — ni résolu, ni rejeté. Or chaque scan en déclenche : 15 à 18
// descripteurs ORB par carte (voir `nReseau` dans le journal). Le premier qui pend fige
// `identifierV2`, donc `gererScanV2`, donc `readInFlight` — et la boucle de détection s'arrête
// pour de bon. Les délais de garde posés en V.25 ne couvraient que les appels aux WORKERS,
// pas le réseau : c'est le trou par lequel ça passait.
// Le corps du message d'erreur nomme l'URL : sans elle, un « échec réseau » ne dit pas si
// c'est le Worker, R2, ou l'index qui a lâché.
async function fetchBorne(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('délai dépassé (' + ms + ' ms) : ' + url);
    throw e;
  } finally { clearTimeout(minuteur); }
}

async function telechargerR2(chemin, { json, gunzip, onOctets } = {}) {
  // L'index global pèse près de 7 Mo : il lui faut plus large que les petits objets.
  const r = await fetchBorne(R2 + '/' + chemin, { cache: 'no-store' }, onOctets ? 120000 : 20000);
  if (!r.ok) throw new Error(chemin + ' : HTTP ' + r.status);
  let buf;
  const total = +(r.headers.get('content-length') || 0);
  if (onOctets && r.body && total) {
    const lecteur = r.body.getReader();
    const morceaux = [];
    let recus = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recus += value.length;
      try { onOctets(recus, total); } catch (e) {}
    }
    const tout = new Uint8Array(recus);
    let off = 0;
    for (const m of morceaux) { tout.set(m, off); off += m.length; }
    buf = tout.buffer;
  } else {
    buf = await r.arrayBuffer();
  }
  if (gunzip) {
    const u = new Uint8Array(buf);
    if (u[0] === 0x1f && u[1] === 0x8b && typeof DecompressionStream === 'function') {   // encore compressé
      const ds = new DecompressionStream('gzip');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    }
  }
  return json ? JSON.parse(new TextDecoder().decode(buf)) : buf;
}

// —— blob ORB d'une carte : [uint16 rows][uint8 rows*32 desc][int16 rows*2 kp] (~25 Ko)
function parseBlobOrb(buf) {
  const dv = new DataView(buf);
  const rows = dv.getUint16(0, true);
  const des = new Uint8Array(buf, 2, rows * 32);
  const kpI16 = new Int16Array(buf.slice(2 + rows * 32, 2 + rows * 32 + rows * 4));
  const kp = []; for (let i = 0; i < rows; i++) kp.push({ x: kpI16[i * 2], y: kpI16[i * 2 + 1] });
  return { rows, des, kp };
}

// ─── MODE « CLASSEUR » SUPPRIMÉ (V.15, décision de Nikos sur relevé réel) ───
//
// Il y avait ici `chargerSetComplet(setId)` + `noterPickV2(setId)` : au bout de 3 scans du
// même set, le pack ORB ENTIER de ce set (~5 Mo) était téléchargé en arrière-plan, au motif
// qu'on dépouille souvent un classeur d'une seule extension et que les scans suivants
// n'auraient alors plus rien à télécharger.
//
// LE RELEVÉ TERRAIN DIT QUE ÇA NE MARCHE PAS (journal /api/scan-log, 3 cartes du set 151
// scannées à la suite sur téléphone, V.14) :
//
//   carte 1 : nManque 18, nReseau 18, net 905 ms, packTelecharge true, sets consultés 14
//   carte 2 : nManque 17, nReseau 17, net 549 ms, packTelecharge true, sets consultés 21
//   carte 3 : nManque 17, nReseau 17, net 719 ms, packTelecharge true, sets consultés 27
//
// Trois cartes du MÊME set, et chacune télécharge quand même 17-18 descripteurs. La raison
// est écrite dans le champ `sets`, qui grossit à chaque scan (14 → 21 → 27) : **la shortlist
// est cross-set**. Les 18 candidats que l'ORB doit départager viennent d'une vingtaine de
// sets différents — les illustrations Pokémon se ressemblent d'une extension à l'autre —
// donc avoir le pack du set dominant ne dispense de presque aucun téléchargement.
//
// Bilan : ~5 Mo de données mobiles dépensés, en concurrence de bande passante avec les
// descripteurs dont le scan a réellement besoin, pour un gain non mesurable. Supprimé.
// Le cache par carte (`orbCharges`, LRU) reste : lui, il sert à chaque scan.

// —— récupère plusieurs blobs ORB d'un coup via le Worker (une requête). Renvoie une
//    Map cle -> ArrayBuffer (ou null si absent).
async function telechargerLotOrb(cles) {
  // Le poste le plus exposé : appelé à CHAQUE scan, pour 15 à 18 descripteurs. C'est ici que
  // le blocage se produisait. 10 s suffisent largement — au-delà, le repli par carte ou le
  // rebut valent mieux qu'une attente sans fin.
  const r = await fetchBorne(R.WORKER_ORB + '?k=' + cles.join(','), { cache: 'no-store' }, 10000);
  if (!r.ok) throw new Error('worker ' + r.status);
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf); const u = new Uint8Array(buf);
  let p = 0; const n = dv.getUint16(p, true); p += 2;
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const lk = u[p++]; let k = '';
    for (let j = 0; j < lk; j++) k += String.fromCharCode(u[p++]);
    const lb = dv.getUint32(p, true); p += 4;
    m.set(k, lb ? buf.slice(p, p + lb) : null); p += lb;
  }
  return m;
}

// —— s'assure que les descripteurs ORB des cartes de la shortlist sont dans le worker :
//    un blob par carte (≈25 Ko), groupés en une requête si le Worker est configuré.
//    Renvoie true si un téléchargement a eu lieu.
async function assurerOrbCartes(cles) {
  let telecharge = false;
  detailRefs = { idb: 0, net: 0, imp: 0, nManque: 0, nReseau: 0, viaWorker: false };
  const manquantes = cles.filter(c => !orbCharges.has(c));
  detailRefs.nManque = manquantes.length;
  if (manquantes.length) {
    onEtat(manquantes.length > 3 ? 'Chargement des références…' : '');

    // ce qui n'est pas déjà en IndexedDB
    const tIdb = performance.now();
    const enIdb = new Map(await Promise.all(manquantes.map(async c => [c, await idbGet('orbc:' + c)])));
    detailRefs.idb = Math.round(performance.now() - tIdb);
    const aTelecharger = manquantes.filter(c => !enIdb.get(c));
    detailRefs.nReseau = aTelecharger.length;
    // Temps de MUR à chaque étape, jamais des sommes : les imports tournent en parallèle,
    // additionner leurs durées donnerait un total supérieur au temps réellement passé.
    // `net` = la requête groupée au Worker, qui est séquentielle et donc mesurable telle
    // quelle. `imp` = tout le reste (injection dans le worker ORB), du CPU. Les séparer est
    // la seule façon de savoir si un `refs` qui gonfle accuse la connexion ou le processeur
    // — voir la session à 6 % de batterie, où TOUT avait triplé sans qu'on sache pourquoi.
    // ATTENTION en lisant : sans Worker (R.WORKER_ORB à null), les téléchargements se font
    // carte par carte À L'INTÉRIEUR du bloc parallèle, donc comptés dans `imp` et non dans
    // `net`. Un `net` à 0 avec un `imp` gonflé veut dire « Worker désactivé », pas « aucun
    // réseau ». Le banc affiche `viaWorker` à côté, qui lève l'ambiguïté.
    let lot = null;
    if (aTelecharger.length >= 4 && R.WORKER_ORB) {
      const tNet = performance.now();
      try { lot = await telechargerLotOrb(aTelecharger); telecharge = true; detailRefs.viaWorker = true; } catch (e) { lot = null; }
      detailRefs.net = Math.round(performance.now() - tNet);
    }

    const tImp = performance.now();
    await Promise.all(manquantes.map(async cle => {
      let buf = enIdb.get(cle);
      if (!buf && lot && lot.has(cle)) { buf = lot.get(cle); if (buf) idbSet('orbc:' + cle, buf); }
      if (!buf) {
        try { buf = await telechargerR2('orb/' + cle + '.orb'); telecharge = true; idbSet('orbc:' + cle, buf); }
        catch (e) { orbCharges.set(cle, { ts: Date.now(), absent: true }); return; }
      }
      // ⚠️ UN ÉCHEC NE DOIT PAS EMPORTER LES DIX-SEPT AUTRES (V.36).
      // Cet appel n'était pas protégé : la moindre erreur faisait rejeter le `Promise.all`,
      // donc `assurerOrbCartes`, dont l'appelant AVALE l'erreur en silence. Le scan
      // continuait alors avec un cache de références vide ou à moitié rempli — l'ORB n'avait
      // plus rien à quoi comparer, rendait 0 ou 1 inlier, et la carte partait en « rebut »
      // comme si elle était méconnaissable. Relevé sur le téléphone de Nikos : les rebuts
      // sont passés de 17 % à 63 %, TOUS avec `sets: 0` (aucune référence chargée) et
      // `refs` à 12 ms — trop court pour avoir importé quoi que ce soit.
      // Les deux durcissements de la V.25 et de la V.33 (délais de garde sur les workers et
      // sur le réseau) ont créé de nouveaux chemins d'échec ici : on a troqué un blocage
      // contre une identification silencieusement fausse, ce qui est pire.
      try {
        const o = parseBlobOrb(buf);
        await orb.call({ type: 'refImport', cle, bytes: o.des, rows: o.rows, kp: o.kp });
        orbCharges.set(cle, { ts: Date.now() });
      } catch (e) {
        detailRefs.nEchecs = (detailRefs.nEchecs || 0) + 1;
        detailRefs.derniereErreur = String(e && e.message || e).slice(0, 80);
        // Pas marquée `absent` : c'est un échec TECHNIQUE, pas une carte sans descripteur.
        // La marquer absente la condamnerait pour toute la session.
      }
    }));
    detailRefs.imp = Math.round(performance.now() - tImp);
  }
  for (const c of cles) { const v = orbCharges.get(c); if (v) v.ts = Date.now(); }
  // Éviction LRU. Le suivi `pleinSet` a disparu avec le mode « classeur » (voir plus haut) :
  // toutes les entrées sont désormais des cartes chargées à l'unité, il n'y a plus de pack
  // entier dont l'éviction partielle invaliderait un set.
  if (orbCharges.size > R.MAX_CARTES_ORB) {
    const tries = [...orbCharges.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const aJeter = tries.slice(0, orbCharges.size - R.MAX_CARTES_ORB).map(x => x[0]);
    const reels = aJeter.filter(c => !orbCharges.get(c).absent);
    if (reels.length) { try { await orb.call({ type: 'dropSet', cles: reels }); } catch (e) {} }
    for (const c of aJeter) orbCharges.delete(c);
  }
  return telecharge;
}

// ─────────────────────────────── état + API publique
let BASE = [], cleToCard = new Map(), pret = false, actif = false, moteurEmb = '?', diagEmb = [];
let EMB_Q8 = null, EMB_DIM = 384;
let manifest = null;
let onEtat = () => {};
const orbCharges = new Map();   // cle -> { ts, absent? }  (descripteurs ORB en mémoire du worker)
let scansV2 = 0, dernierOrbMs = 0;
// Ventilation du dernier `refs` (voir assurerOrbCartes) : remontée dans T.refsDetail.
let detailRefs = { idb: 0, net: 0, imp: 0, nManque: 0, nReseau: 0, viaWorker: false };

// Le tas WASM d'OpenCV se fragmente : au bout de ~12 scans l'ORB dérive (300 ms → 2 s+).
// On recycle le worker et on laisse le prochain scan réinjecter depuis le cache IndexedDB.
// ═════════════════════════════════════════════════════════════════════════════════════════
// TAILLE DU CACHE ORB — libérer au fil de l'eau plutôt que tout jeter tous les douze scans.
// ═════════════════════════════════════════════════════════════════════════════════════════
// Chaque scan injecte dix-huit jeux de descripteurs dans le worker, et rien n'en sortait
// avant le recyclage. Relevé sur le téléphone de Nikos, colonne `sets` d'une session :
// 14, 28, 41, 45, 68, 72, 77, 79, 83, 85 — puis 16, le worker venait d'être redémarré.
// Jusqu'à deux cents jeux détenus dans le tas WASM d'OpenCV, et le prix se voit : `imp`,
// qui est du processeur pur (injection des descripteurs, taille constante), passe de 10 ms
// à plus de 200. Un facteur vingt sur une opération qui ne change pas de taille.
// L'appariement, lui, ne souffre pas — `querySubset` ne compare qu'aux clés demandées. Ce
// n'est donc pas le calcul qui se dégrade, c'est l'allocation.
// On garde les plus récemment servies et on rend les autres. Le worker sait déjà le faire :
// le message `dropSet` était écrit, testé, et n'avait jamais été appelé par personne.
async function taillerOrb() {
  if (!R.ORB_MAX_REFS || orbCharges.size <= R.ORB_MAX_REFS) return;
  const parAge = [...orbCharges.entries()].sort((a, b) => b[1].ts - a[1].ts);
  const aRendre = parAge.slice(R.ORB_MAX_REFS).map(([cle]) => cle);
  if (!aRendre.length) return;
  // Les entrées « absent » ne pèsent rien dans le worker (rien n'y a été importé) mais
  // évitent de retélécharger un descripteur inexistant : on les garde côté JS.
  const dansLeWorker = aRendre.filter(c => !orbCharges.get(c).absent);
  for (const c of aRendre) orbCharges.delete(c);
  if (dansLeWorker.length) {
    try { await orb.call({ type: 'dropSet', cles: dansLeWorker }); }
    catch (e) { /* le recyclage périodique reste le filet */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// LE RECYCLAGE NE DOIT PLUS SE PAYER PENDANT UN SCAN
// ═════════════════════════════════════════════════════════════════════════════════════════
// Il était appelé DANS identifierV2, donc l'utilisateur attendait le redémarrage du worker
// au milieu d'une carte. Mesuré sur trente identifications d'affilée, compteur remis à zéro :
//     régime            782 ms  (médiane, orb ~348, imp 5 à 12)
//     scan n° 13       2098 ms
//     scan n° 25       1631 ms
// Soit 850 à 1300 ms une fois tous les douze scans — et INVISIBLE dans la ventilation T,
// puisque le recyclage précède les étapes chronométrées. C'est très exactement pour cela
// que le profil ne le trouvait pas : je cherchais dans les étapes une dépense qui était
// avant elles.
//
// On ne le supprime pas : il protège d'une dérive réelle du tas WASM (voir plus haut, 300 ms
// → 2 s+). On le déplace. `entretienOrbV2` est appelé quand le scanner n'a rien à faire —
// entre deux cartes — et le filet en ligne ne se déclenche plus qu'au DOUBLE du compte, pour
// les appelants qui n'ont pas d'instant creux à offrir (import d'un lot, file d'attente).
let scansDepuisRecyclage = 0;

async function recyclerOrbSiBesoin() {
  // Filet de dernier recours seulement : deux fois le compte normal.
  if (!R.RECYCLE_ORB || scansDepuisRecyclage < R.RECYCLE_ORB * 2) return;
  await recyclerOrb();
  scansDepuisRecyclage = 0;
}

// À appeler quand rien n'attend : le coût est le même, le moment ne l'est pas.
export async function entretienOrbV2() {
  if (!R.RECYCLE_ORB || scansDepuisRecyclage < R.RECYCLE_ORB) return false;
  await recyclerOrb();
  scansDepuisRecyclage = 0;
  return true;
}
async function recyclerOrb() {
  try { orb.terminate(); } catch (e) {}
  demarrerOrb();
  await orb.call({ type: 'warm' }).catch(() => {});
  orbCharges.clear();
}

// Remise à zéro des caches, pour le banc : mesurer un démarrage à froid, ou isoler ce que
// le Worker Cloudflare fait vraiment gagner. `memoire` vide le worker ORB (les descripteurs
// restent en IndexedDB, donc pas de réseau) ; `disque` vide AUSSI IndexedDB, ce qui force
// un vrai retéléchargement. L'index d'empreintes global n'est jamais touché : le reprendre
// coûterait 3 Mo à chaque essai sans rien apprendre.
export async function viderCachesV2({ memoire = true, disque = false } = {}) {
  if (disque) await idbDelPrefixe('orbc:');
  if (memoire || disque) { await recyclerOrb(); scansV2 = 0; scansDepuisRecyclage = 0; dernierOrbMs = 0; }
  return { memoire: memoire || disque, disque };
}

const setsCharges = () => [...new Set([...orbCharges.keys()].map(c => String(c).slice(0, String(c).lastIndexOf('-'))))];

export function pretV2() { return pret; }
export function actifV2() { return pret && actif; }
export function basculerV2(on) { actif = !!on; }
export function moteurV2() { return moteurEmb; }
export function diagV2() { return diagEmb; }
export function setV2() { return setsCharges(); }
export function trancheV2() { return manifest?.slice || null; }
// Les sets du manifeste : nom lisible et dénominateur imprimé, construits avec les packs.
// Une carte identifiée peut donc afficher « Ténèbres Embrasées » et « /189 » sans un seul
// appel réseau — l'index interne portait déjà tout le reste.
export function setsV2() { return manifest?.sets || null; }
// Catalogue chargé, pour le banc : de quoi tirer un échantillon au hasard dans TOUTE la
// tranche plutôt que dans le seul set des 31 photos. Copie superficielle — le banc n'a
// aucune raison de tenir l'index par référence.
export function catalogueV2() {
  return BASE.map(c => ({ cle: c.cle, setId: c.setId, numero: c.numero, name: c.name, image: c.image }));
}
export function surEtatV2(cb) { onEtat = typeof cb === 'function' ? cb : (() => {}); }

// Étalon de vitesse : le MÊME embedding sur la MÊME image, mesuré à la demande. Une
// session de test a été perdue faute de pouvoir répondre à « le téléphone est-il bridé ? »
// — tout avait triplé à la fois (emb, refs, orb) sans qu'on sache accuser le code ou
// l'appareil. C'était l'économie d'énergie à 6 % de batterie. Cet étalon tranche en deux
// secondes, et se relance en cours de session pour voir la chauffe arriver.
export async function etalonV2(n = 3) {
  const c = document.createElement('canvas');
  c.width = 224; c.height = 224;
  const g = c.getContext('2d');
  // Motif déterministe : deux appels doivent mesurer l'appareil, jamais l'image.
  for (let y = 0; y < 224; y += 16) for (let x = 0; x < 224; x += 16) {
    g.fillStyle = `rgb(${(x * 7) % 256},${(y * 11) % 256},${((x + y) * 5) % 256})`;
    g.fillRect(x, y, 16, 16);
  }
  const url = c.toDataURL('image/jpeg', 0.9);
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try { await embed(url); } catch (e) { return { erreur: String(e && e.message || e) }; }
    t.push(Math.round(performance.now() - t0));
  }
  const tri = t.slice().sort((a, b) => a - b);
  return { median: tri[Math.floor(tri.length / 2)], mesures: t, moteur: moteurEmb };
}

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

  const cleIdx = 'idx:' + version;
  let bin = await idbGet(cleIdx);
  let meta = await idbGet('meta:' + version);
  if (!bin || !meta) {
    // Premier lancement, ou nouvel index après un build : c'est LE moment long. On rapporte
    // l'avancement en octets (0,05 → 0,50) pour que l'écran de chargement dise la vérité.
    onProgress(0.05, 'Téléchargement du catalogue…');
    const mo = o => (Math.round(o / 104857.6) / 10).toFixed(1);
    bin = await telechargerR2('index-global.bin', {
      onOctets: (recus, tot) => onProgress(0.05 + 0.45 * (recus / tot),
        'Téléchargement du catalogue… ' + mo(recus) + ' / ' + mo(tot) + ' Mo')
    });
    onProgress(0.5, 'Fiche des cartes…');
    meta = await telechargerR2('index-global-meta.json.gz', { json: true, gunzip: true });
    idbDelPrefixe('idx:', cleIdx); idbDelPrefixe('meta:', 'meta:' + version);
    idbSet(cleIdx, bin); idbSet('meta:' + version, meta);
  } else {
    // Déjà en cache : on saute directement à la fin de la phase réseau, sinon la barre
    // resterait à 5 % puis bondirait à 55 % sans que rien ne se soit passé.
    onProgress(0.5, 'Catalogue en cache…');
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

  // ⚠️ L'OCR PART EN ARRIÈRE-PLAN (V.24). Il bloquait la mise à disposition du scanner, et
  // c'était l'essentiel des « plus de 30 secondes » signalées. Trois coûts s'y enchaînaient,
  // tous AVANT que `pret` ne passe à vrai :
  //   1. `chargerParsing()` retélécharge index.html EN ENTIER, `cache:'no-store'`, juste pour
  //      en extraire un bloc de code — presque un mégaoctet sur le réseau mobile ;
  //   2. la création du worker OCR ;
  //   3. `ocrLire(warm)` : une inférence complète sur une toile vide, qui déclenche à elle
  //      seule le chargement du modèle Paddle (~6 Mo) et sa compilation.
  // Or l'OCR ne sert QU'À DÉPARTAGER une égalité — une petite minorité de scans — et
  // `identifierV2` le teste déjà (`if (ocr && …)`) : sans lui, elle s'en passe proprement.
  // Le faire attendre au démarrage, c'était refaire l'erreur corrigée en V.14 côté
  // application, où la boucle attendait ce même moteur pour rien.
  onProgress(0.8, 'Moteurs…');
  const ocrEnFond = chargerParsing()
    .then(p => { demarrerOcr(p); })
    .catch(() => { /* OCR optionnel : le départage sera simplement sauté */ });

  onProgress(0.9, 'Préchauffage…');
  const warm = document.createElement('canvas'); warm.width = 140; warm.height = 196;
  warm.getContext('2d').fillRect(0, 0, 140, 196);
  const [w] = await Promise.all([
    emb.call({ type: 'warm' }).catch(e => ({ moteur: '?', diag: [String(e && e.message || e)] })),
    orb.call({ type: 'warm' }).catch(() => {}),
  ]);
  moteurEmb = w.moteur || '?';
  diagEmb = w.diag || [];
  const tw = performance.now();
  await embed(versDataUrl(warm, null)).catch(() => {});   // 1re inférence réelle : compile les kernels
  diagEmb.push('warm1=' + Math.round(performance.now() - tw) + 'ms');
  pret = true;

  // Après coup, hors du chemin critique : la 2e inférence ne sert QU'À MESURER le temps « à
  // chaud » (diagnostic), et le préchauffage OCR n'a d'intérêt que pour le premier départage,
  // qui n'arrivera pas avant plusieurs scans. Ni l'un ni l'autre ne doit retarder la caméra.
  (async () => {
    const t2 = performance.now();
    await embed(versDataUrl(warm, null)).catch(() => {});
    diagEmb.push('warm2=' + Math.round(performance.now() - t2) + 'ms');
    await ocrEnFond;
    if (ocr) await ocrLire(warm).catch(() => {});
  })();
  onProgress(1, `V2 prête — ${BASE.length} cartes, ${manifest.sets ? Object.keys(manifest.sets).length : '?'} sets (${moteurEmb}).`);
  return { cartes: BASE.length, moteur: moteurEmb };
}

// Identifie une carte déjà redressée (canvas). Renvoie pick + fiabilité + catégorie.
// `opts.onProvisoire(avis)` — appelé UNIQUEMENT quand l'OCR de départage va se lancer, juste
// avant qu'il ne parte, avec le meilleur candidat de l'ORB à cet instant. Il permet à
// l'appelant d'afficher tout de suite une première idée pendant que la vérification se fait,
// au lieu de laisser l'écran vide 0,3 à 3,2 s (relevé terrain : 3 226 ms sur `me02-123`).
// L'avis est PROVISOIRE : c'est exactement le candidat que l'OCR est en train de contester.
// Le résultat renvoyé par la promesse reste la seule vérité, et c'est lui qui décide de tout
// ce qui s'enregistre — la file, le classeur, le stock, le journal.
// ═════════════════════════════════════════════════════════════════════════════════════════
// L'EMPREINTE, SÉPARABLE DU RESTE
// ═════════════════════════════════════════════════════════════════════════════════════════
// Elle vaut 39 % du temps d'identification (288 ms sur 736, mesuré) et ne dépend que de
// l'image. Rien n'oblige à la calculer APRÈS le déclenchement : pendant que la boucle attend
// que la main se stabilise — six cent trente millisecondes en médiane sur le téléphone — le
// GPU ne fait presque rien.
// Coût mesuré de la faire tourner en parallèle de la détection : celle-ci passe de 43 à
// 68 ms, soit vingt-cinq millisecondes par tour. Une seule spéculation, au tour où tout
// passe sauf la stabilité, rend donc quatre cents millisecondes nettes.
// Si l'image change entre la spéculation et la capture, le calcul est perdu et on reprend le
// chemin normal : aucune régression possible, seulement un gain manqué.
async function empreinte(carte) {
  const petit = document.createElement('canvas');
  petit.width = 320; petit.height = Math.round(320 * CARD_RATIO);
  petit.getContext('2d').drawImage(carte, 0, 0, petit.width, petit.height);
  const e = await embed(versDataUrl(petit, ZONE_ILLUSTRATION));
  const ev = e.v, q8 = EMB_Q8, D = EMB_DIM;
  const parEmb = BASE.map(c => {
    let s = 0; const o = c.off;
    for (let j = 0; j < D; j++) s += q8[o + j] * ev[j];
    return { cle: c.cle, s: s * c.inv };
  }).sort((a, b) => b.s - a.s);
  // `large` : le même classement par empreinte, mais poussé bien plus loin. L'appariement
  // ORB ne travaille que sur `court` — dix-huit candidats, c'est son budget. Mais le
  // secours par le nom, lui, ne coûte qu'une comparaison de chaînes : il peut fouiller cinq
  // cents cartes sans que personne ne le sente. Or c'est exactement ce qu'il fallait :
  // relevé sur la photo 170 du set 151, l'OCR lisait « Carapuce » sans erreur, mais Carapuce
  // n'était PAS dans les dix-huit — la présélection proposait Crapustule, Natu, Léboulérou.
  // Le nom était juste et inutilisable, faute de candidat à désigner.
  return { embTop: parEmb[0].s, court: parEmb.slice(0, R.SHORT).map(x => x.cle),
           large: parEmb.slice(0, R.NOM_PROFONDEUR).map(x => x.cle) };
}

// À passer ensuite à identifierV2 dans `opts.pre`. Rend null plutôt que de jeter : un
// pré-calcul raté ne doit jamais empêcher le scan qui suit.
// `orb: true` : on profite du même passage pour aller chercher les descripteurs de la
// présélection. Mesuré sur vingt cartes, l'étape refs oscille entre 18 et 445 ms selon
// qu'ils sont en cache ou non — 216 ms de médiane. Les demander pendant que l'utilisateur
// stabilise encore sa carte les rend gratuits au moment de la lecture.
export async function preparerV2(carte, opts = {}) {
  if (!pret) return null;
  try {
    const t0 = performance.now();
    const r = await empreinte(carte);
    const T = { emb: Math.round(performance.now() - t0) };
    if (opts.orb) {
      const t1 = performance.now();
      try { await assurerOrbCartes(r.court); } catch (e) {}
      T.refs = Math.round(performance.now() - t1);
    }
    return { ...r, T };
  } catch (e) { return null; }
}

export async function identifierV2(carte, opts = {}) {
  if (!pret) throw new Error('V2 pas prête');
  const T = {};
  const chrono = async (k, p) => { const t = performance.now(); const r = await p; T[k] = Math.round(performance.now() - t); return r; };

  // 1. embedding → shortlist. Peut avoir été calculé D'AVANCE (voir preparerV2).
  const pre = opts.pre && opts.pre.court ? opts.pre : null;
  const { embTop, court, large } = pre || await chrono('emb', empreinte(carte));
  if (pre && pre.T && pre.T.emb != null) T.embAvance = pre.T.emb;
  // Ce que l'embedding SEUL proposait, avant que l'ORB ne reclasse. Sans cette trace, on ne
  // peut pas savoir ce qu'on jette quand l'ORB devient aveugle (image floue ET réduite :
  // zéro inlier sur toute la shortlist) — or il reste peut-être une bonne réponse dedans.
  const embPremier = court[0];

  // 2. descripteurs ORB des cartes de la shortlist (un petit blob par carte, à la demande)
  await recyclerOrbSiBesoin();
  let packTelecharge = false;
  // Le `catch` vide d'origine masquait une panne totale des références : sans descripteurs,
  // l'ORB compare la carte à rien, rend zéro inlier, et le scan repart en « rebut » avec
  // l'assurance d'un vrai refus. On garde le scan en vie — l'embedding seul vaut mieux que
  // rien — mais on note la panne pour qu'elle apparaisse au journal au lieu de se déguiser
  // en carte méconnaissable.
  try { packTelecharge = await chrono('refs', assurerOrbCartes(court)); }
  catch (err) { detailRefs.panne = String(err && err.message || err).slice(0, 80); }
  T.refsDetail = { ...detailRefs };
  onEtat('');

  // 3. ORB reclasse la shortlist — EN DEUX TEMPS.
  // L'appariement coûte proportionnellement au nombre de candidats : mesuré, 324 ms pour 18,
  // 128 ms pour 6. Mais on ne peut pas raccourcir la shortlist : un banc sur 7 591 cartes a
  // montré que 12 laisse déjà la bonne carte dehors une fois sur huit, et vingt-quatre cartes
  // ne renversent pas sept mille.
  // On garde donc les DIX-HUIT, et on les regarde en deux fois. Si les six premiers donnent
  // une géométrie franche — assez d'inliers ET un second candidat nettement derrière, les
  // deux mêmes critères que `geoFranche` — la réponse ne changerait pas en regardant les
  // douze autres. Sinon on les regarde. Le recall de dix-huit est conservé PAR CONSTRUCTION :
  // rien n'est exclu, seulement différé.
  let ranked = court, orbScores = {};
  const fusionner = (rr) => {
    rr.out.forEach(o => (orbScores[o.cle] = o.score));
    ranked = Object.keys(orbScores).sort((a, b) => (orbScores[b] || 0) - (orbScores[a] || 0));
  };
  const francs = (cles) => {
    const tri = cles.slice().sort((a, b) => (orbScores[b] || 0) - (orbScores[a] || 0));
    const p = orbScores[tri[0]] || 0, d = orbScores[tri[1]] || 0;
    return p >= R.GEO_INLIERS && (p > 0 ? (p - d) / p : 0) >= R.GEO_DOM;
  };
  try {
    const tete = court.slice(0, R.ORB_PREMIER);
    const reste = court.slice(R.ORB_PREMIER);
    const t0orb = performance.now();
    const bmp1 = await createImageBitmap(carte);
    fusionner(await orb.call({ type: 'querySubset', bitmap: bmp1, cles: tete }, [bmp1]));
    T.orbTete = Math.round(performance.now() - t0orb);
    if (reste.length && !francs(tete)) {
      const bmp2 = await createImageBitmap(carte);
      fusionner(await orb.call({ type: 'querySubset', bitmap: bmp2, cles: reste }, [bmp2]));
      T.orbSuite = Math.round(performance.now() - t0orb) - T.orbTete;
    }
    T.orb = Math.round(performance.now() - t0orb);
  } catch (err) {}
  dernierOrbMs = T.orb || dernierOrbMs;
  // Après l'appariement, pas avant : les descripteurs de CE scan viennent d'être marqués
  // récents par assurerOrbCartes, ils ne seront donc jamais les premiers rendus.
  await taillerOrb();

  let pick = ranked[0];
  let inl = orbScores[pick] || 0;
  const second = ranked.find(c => c !== pick);
  let marge = inl - (orbScores[second] || 0);
  const dominance0 = inl > 0 ? marge / inl : 0;

  // 4. OCR — uniquement pour départager une ÉGALITÉ. Sur 15 lancements en session réelle,
  //    l'OCR n'a changé le verdict que 2 fois, et les deux fois dans le même cas de figure :
  //    beaucoup d'inliers (35 et 53) mais un 2e candidat au coude à coude (dominance 0,57 et
  //    0). Les 13 autres avaient ≤ 20 inliers — quand l'homographie ne trouve presque rien,
  //    c'est que la photo est mauvaise ou la carte hors index, et l'OCR du numéro échoue pour
  //    les mêmes raisons ; il ne faisait qu'ajouter 0,3 à 4,3 s avant un verdict inchangé.
  //    Garde-fou thermique conservé : session chaude → on ne tente même pas.
  //
  //    ⚠️ AJOUT V.19 — la dominance seule est un RATIO, et un ratio ne distingue pas deux
  //    situations qui n'ont rien à voir :
  //        35 inliers contre 15  → marge 20, dominance 0,57  → vraie égalité, l'OCR sert
  //        93 inliers contre 39  → marge 54, dominance 0,58  → écart décisif, l'OCR ne sert à rien
  //    Les deux passaient le test. Le second cas a été relevé sur le téléphone (`me02-123`,
  //    98 % de fiabilité, verdict JUSTE) : l'OCR y a coûté 3 226 ms pour confirmer ce qui
  //    était déjà acquis — c'était le pire pic de toute la salve. Et il est devenu plus
  //    fréquent depuis que l'ORB est rapide, car le garde-fou thermique (OCR_ORB_MS_MAX)
  //    ne se déclenche plus.
  //    On exige donc AUSSI un coude-à-coude en valeur absolue. Le seuil (35) est calé pour
  //    préserver les deux seuls cas où l'OCR a jamais changé un verdict — marges 20 et 0 —
  //    tout en écartant ceux mesurés au banc et sur le terrain (marges 54 et au-delà).
  const orbEgalite = inl >= R.OCR_INLIERS_MIN
                  && dominance0 < R.OCR_DOM_MAX
                  && marge < R.OCR_MARGE_MAX;
  let ocrCands = [], ocrTxt = '', ocrLance = false;
  if (ocr && orbEgalite && dernierOrbMs < R.OCR_ORB_MS_MAX) {
    ocrLance = true;
    // Première idée, tout de suite : l'ORB a déjà un favori, il est simplement trop serré
    // pour qu'on s'y fie seul. Autant le montrer pendant qu'on tranche.
    if (typeof opts.onProvisoire === 'function') {
      const c0 = pick && cleToCard.get(pick);
      if (c0) {
        try {
          opts.onProvisoire({
            pick: { cle: c0.cle, numero: c0.numero, name: c0.name, setId: c0.setId,
                    localId: c0.localId, image: c0.image },
            inliers: Math.round(inl), marge: Math.round(marge),
          });
        } catch (e) { /* l'affichage ne doit jamais casser l'identification */ }
      }
    }
    try { const r = await chrono('ocr', ocrLire(bandeBasse(carte))); ocrCands = r.cands || []; ocrTxt = r.text || ''; } catch (e) {}
    if (ocrCands.length) {
      const nums = new Set(ocrCands.map(c => c.number));
      const hit = ranked.slice(0, R.TIEBREAK).find(cle => nums.has(cleToCard.get(cle).numero));
      if (hit) { pick = hit; inl = orbScores[pick] || 0; marge = inl - (orbScores[second] || 0); }
    }
  }

  // ─── SECOURS PAR LE NOM ─────────────────────────────────────────────────────────────
  // L'appariement n'a rien donné de solide : plutôt que de rendre un rebut, on lit le nom
  // écrit sur la carte et on cherche qui, dans la présélection, le porte. Ces captures-là
  // coûtent déjà leur seconde et ne rendent rien ; y ajouter l'OCR est le seul moment où il
  // vaut son prix.
  let nomLu = '', nomSecours = false;
  // Le garde-fou thermique vaut ici aussi : quand le dernier appariement a traîné, l appareil
  // chauffe et ce n est pas le moment de lui demander une inférence de plus. Le départage par
  // le numéro le respectait, ce secours l ignorait — sur une longue salve, c est précisément
  // la fin de session qui en aurait souffert.
  if (R.NOM_ACTIF && ocr && inl < R.NOM_INLIERS_MAX && dernierOrbMs < R.OCR_ORB_MS_MAX) {
    try {
      const r = await chrono('ocrNom', ocrLire(bandeHaute(carte)));
      nomLu = (r && r.text) || '';
    } catch (e) {}
    if (nomLu) {
      // La présélection de l'empreinte D'ABORD, le classement ORB ensuite :
      // quand l'appariement échoue son ordre ne vaut rien, alors que l'empreinte, elle, a
      // bien rapproché la carte de quelque chose.
      const porteLeNom = cle => { const c = cleToCard.get(cle);
        return c && nomTrouve(nomLu, c.name, R.NOM_ECART_MAX); };
      // D'abord les candidats que l'appariement a examinés : s'il y a là une carte du bon
      // nom, c'est la meilleure réponse possible.
      const proches = [...new Set([...(court || []), ...ranked])].slice(0, R.NOM_CANDIDATS);
      let gagnant = proches.find(porteLeNom);
      // Sinon on descend le classement par empreinte. L'ordre reste celui de la ressemblance
      // visuelle : la première carte du bon nom est donc la plus proche de ce qu'on a vu.
      if(!gagnant && large) gagnant = large.find(porteLeNom);
      if (gagnant) {
        pick = gagnant; nomSecours = true;
        inl = Math.max(inl, orbScores[gagnant] || 0);
        marge = 0;
      }
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
  // « sûre » aussi quand la géométrie est franche : ≥ 20 inliers vérifiés par l'homographie
  // et un 2e candidat nettement derrière — c'est une identification certaine même si la
  // sigmoïde (calibrée prudemment) reste à ~77 %.
  const geoFranche = inl >= R.GEO_INLIERS && dom >= R.GEO_DOM;
  let categorie;
  if (!pick || (inl < R.INLIERS_MIN && !ocrOk && !nomSecours)) categorie = 'rebut';
  else if (fiabilite >= 80 || ocrOk || geoFranche) categorie = 'sure';
  else categorie = 'douteuse';
  // Une carte retrouvée par son nom seul est « à vérifier », jamais « sûre » : le nom ne
  // distingue pas deux impressions du même Pokémon, et l'appariement n'a rien confirmé. La
  // fiabilité annoncée le dit — plafonnée, pour ne pas laisser croire à une certitude.
  if (nomSecours && categorie !== 'sure') categorie = 'douteuse';

  scansV2++; scansDepuisRecyclage++;   // (noterPickV2 — mode « classeur » — retiré, voir plus haut)

  return {
    pick: cible ? { cle: cible.cle, numero: cible.numero, name: cible.name, setId: cible.setId, localId: cible.localId, image: cible.image } : null,
    fiabilite: nomSecours && !ocrOk ? Math.min(fiabilite, 60) : fiabilite,
    categorie, inliers: Math.round(inl), marge: Math.round(marge), embTop, embPremier, ocrTxt, ocrLance, ocrOk,
    nomLu, nomSecours,
    packTelecharge, setsCharges: setsCharges(),
    // Somme des seules ÉTAPES : T porte aussi refsDetail, qui est une ventilation de
    // `refs` et non une durée de plus — l'additionner compterait deux fois, et comme c'est
    // un objet le total serait NaN.
    ms: Object.values(T).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0), T, moteur: moteurEmb,
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
    const r = await fetchBorne('/api/scan-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: idAppareil(), outil: 'v2-prod', entries: liste }),
    });
    return r.ok;
  } catch (e) { return false; }
}
