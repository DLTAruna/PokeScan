// ═════════════════════════════════════════════════════════════════════════════════════════
// DUEL — le scanner de test contre le banc V2, sur exactement le même flux
// ═════════════════════════════════════════════════════════════════════════════════════════
// Nikos trouve le banc nettement plus rapide et plus sûr. Les journaux de terrain ne peuvent
// pas trancher : ils comparent deux paquets, deux moments, deux réglages d'objectif. Ce
// fichier supprime toutes ces variables d'un coup.
//
// Principe : on remplace getUserMedia par un flux synthétique. Chaque outil ouvre alors SA
// caméra par SON chemin habituel — rien n'est court-circuité, ni la boucle, ni les seuils,
// ni la capture — mais les deux voient la même carte, au même endroit, avec le même
// tremblement. Ce qui reste comme différence est du code, et seulement du code.
//
// Effet de bord voulu : un flux de canevas n'a pas de capacité de zoom, donc aucun des deux
// outils n'en applique. La question de l'objectif — la seule que les journaux désignaient —
// est donc neutralisée ici. Ce banc mesure ce qui reste une fois qu'elle est écartée.
//
// Trois durées, décomposées :
//     amont          présentation de la carte → capture partie (détection + attente + découpe)
//     identification identifierV2, tel que l'outil le journalise
//     total          présentation → verdict disponible
// Se charge sur index.html (onglet Scanner test) comme sur bench-v2.html : il reconnaît la
// page à ce qu'elle expose.

(function(){
'use strict';

const D = {};
window.DUEL = D;

const L = 1080, H = 1440, RATIO = 88/63;

D.outil = (typeof window.BANC !== 'undefined' && window.BANC.camera) ? 'banc'
        : (typeof window.SCAN_V2 !== 'undefined' && document.getElementById('st-video')) ? 'scanner'
        : null;

// ── Le catalogue, tiré à l'identique des deux côtés ─────────────────────────────────────
// La graine rend le tirage REPRODUCTIBLE : sans elle, les deux outils recevraient deux
// paquets différents et l'on retomberait exactement dans le biais qu'on veut éliminer.
function alea(graine){
  let s = graine >>> 0;
  return () => { s = (s*1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
D.tirer = function(n, graine){
  const V2 = window.SCAN_V2 || window.V2;
  const tout = V2.catalogueV2().filter(c => c.image);
  const r = alea(graine || 20260902);
  const out = [];
  for(let i = 0; i < n; i++) out.push(tout[Math.floor(r()*tout.length)]);
  return out;
};

D.image = base => new Promise((res, rej) => {
  const i = new Image(); i.crossOrigin = 'anonymous';
  i.onload = () => res(i); i.onerror = () => rej(new Error('image indisponible'));
  i.src = /\.(webp|png|jpg|jpeg)$/i.test(base) ? base : base + '/high.webp';
});

// ── La scène ────────────────────────────────────────────────────────────────────────────
const scene = document.createElement('canvas');
scene.width = L; scene.height = H;
const g = scene.getContext('2d');
let piste = null;

function fond(){
  g.fillStyle = '#6b4a2f'; g.fillRect(0, 0, L, H);
  for(let y = 0; y < H; y += 9){
    g.fillStyle = 'rgba(0,0,0,' + (0.03 + ((y*97)%37)/500).toFixed(3) + ')';
    g.fillRect(0, y, L, 5);
  }
}
function poser(img, o){
  fond();
  const h = H*o.hFrac, l = h/RATIO;
  g.save();
  g.translate(o.cx*L, o.cy*H); g.rotate(o.angle || 0);
  g.fillStyle = 'rgba(0,0,0,.42)'; g.fillRect(-l/2+7, -h/2+9, l, h);
  g.drawImage(img, -l/2, -h/2, l, h);
  g.restore();
}
function livrer(){ try{ if(piste) piste.requestFrame(); }catch(e){} }

// ── Le flux synthétique, substitué à la caméra ──────────────────────────────────────────
// captureStream(0) et non (30) : à cadence libre le canevas est capté quand il veut, donc
// parfois entre l'effacement du fond et le dessin de la carte. On livrait alors des images
// vides comptées comme « le détecteur ne voit rien ». À zéro, c'est nous qui livrons.
let vraiGUM = null;
D.brancher = function(){
  if(vraiGUM) return;
  fond();
  const flux = scene.captureStream(0);
  piste = flux.getVideoTracks()[0];
  vraiGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async () => flux;
  livrer();
};
D.debrancher = function(){
  if(vraiGUM){ navigator.mediaDevices.getUserMedia = vraiGUM; vraiGUM = null; }
  try{ if(piste) piste.stop(); }catch(e){}
  piste = null;
};

// ── Combien de verdicts l'outil a-t-il rendus ? ─────────────────────────────────────────
D.compte = function(){
  if(D.outil === 'banc') return window.BANC.scans().length;
  return ST.pile.length + ST.aConfirmer.length;
};
D.dernier = function(){
  if(D.outil === 'banc'){ const s = window.BANC.scans(); return s[s.length-1] || null; }
  return ST.dernier || null;
};

// ── Le tremblement, identique des deux côtés ────────────────────────────────────────────
const TREMBLE = { balancement:{amp:0.010, hz:0.8}, physio:{amp:0.0025, hz:6}, approche:0.45 };
D.TREMBLE = TREMBLE;

// ── Une carte, du néant au verdict ──────────────────────────────────────────────────────
D.carte = async function(c, o){
  const img = await D.image(c.image);
  const avant = D.compte();

  // Champ vide : c'est ce qui sépare deux cartes dans la vraie vie, et l'omettre ferait
  // démarrer le chronomètre sur un verrou déjà à moitié ouvert.
  let raf = 0;
  const vide = () => { fond(); livrer(); raf = requestAnimationFrame(vide); };
  vide();
  await new Promise(r => setTimeout(r, o.videMs || 600));
  cancelAnimationFrame(raf);

  const t0 = performance.now();
  const depart = { cx: 0.5 + (Math.random()-0.5)*0.12, cy: 0.5 + (Math.random()-0.5)*0.10 };
  const phi = Math.random()*6.28, angle0 = (Math.random()-0.5)*0.16;
  const peindre = () => {
    const s = (performance.now() - t0)/1000;
    const k = Math.exp(-s/TREMBLE.approche);
    const tr = TREMBLE.balancement.amp*Math.sin(2*Math.PI*TREMBLE.balancement.hz*s + phi)
             + TREMBLE.physio.amp*Math.sin(2*Math.PI*TREMBLE.physio.hz*s + phi*2);
    poser(img, { cx: 0.5 + (depart.cx-0.5)*k + tr,
                 cy: 0.5 + (depart.cy-0.5)*k + tr*0.6,
                 hFrac: o.taille, angle: angle0*k + tr*0.5 });
    livrer();
    raf = requestAnimationFrame(peindre);
  };
  peindre();

  const limite = o.limiteMs || 8000;
  while(D.compte() === avant && performance.now() - t0 < limite)
    await new Promise(r => setTimeout(r, 25));
  const tFin = performance.now();
  cancelAnimationFrame(raf);

  const abouti = D.compte() > avant;
  const d = abouti ? D.dernier() : null;
  // `ms` est la durée d'identification telle que l'outil la journalise lui-même.
  const ident = d ? (d.ms || 0) : 0;
  const total = Math.round(tFin - t0);
  return { cle: c.cle, abouti,
           total, identification: ident, amont: Math.max(0, total - ident),
           inliers: d ? d.inliers : null,
           categorie: d ? d.categorie : null,
           juste: d ? ((d.trouve || (d.carte && d.carte.cle)) === c.cle) : null,
           // Seul le scanner de test mesure l'attente de déclenchement ; le banc l'ignore.
           attendu: d && d.attendu != null ? d.attendu : null };
};

// ── La série ────────────────────────────────────────────────────────────────────────────
D.progression = [];
D.serie = async function(opts){
  const o = Object.assign({ n:50, taille:0.62, graine:20260902, videMs:600, limiteMs:8000 }, opts||{});
  // Liste fournie ? On l'utilise telle quelle. C'est ainsi que les deux outils reçoivent
  // EXACTEMENT les mêmes cartes : le banc n'expose pas le catalogue, on le lui apporte.
  const cartes = o.cartes || D.tirer(o.n, o.graine);
  D.progression = [];
  const R = [];
  for(const c of cartes){
    let r;
    try{ r = await D.carte(c, o); }
    catch(e){ continue; }
    R.push(r); D.progression.push(r);
  }
  D.resultats = R;
  return R;
};

D.bilan = function(R){
  R = R || D.resultats || [];
  const ok = R.filter(x => x.abouti);
  const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s.length? Math.round(s[s.length>>1]) : null; };
  const q = (a,p) => { const s=[...a].sort((x,y)=>x-y); return s.length? Math.round(s[Math.floor(s.length*p)]) : null; };
  const pc = (a,f) => a.length ? Math.round(100*a.filter(f).length/a.length) : 0;
  return {
    outil: D.outil, n: R.length,
    aboutis: ok.length + '/' + R.length,
    justes: pc(ok, x => x.juste === true) + ' %',
    sures: pc(ok, x => x.categorie === 'sure') + ' %',
    inliersMed: med(ok.map(x => x.inliers).filter(v => v != null)),
    amont: { med: med(ok.map(x=>x.amont)), p90: q(ok.map(x=>x.amont), 0.9) },
    identification: { med: med(ok.map(x=>x.identification)), p90: q(ok.map(x=>x.identification), 0.9) },
    total: { med: med(ok.map(x=>x.total)), p90: q(ok.map(x=>x.total), 0.9) },
  };
};

console.log('duel chargé — outil détecté : ' + D.outil);
})();
