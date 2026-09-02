// ═════════════════════════════════════════════════════════════════════════════════════════
// BANC DE DÉCLENCHEMENT — se charge PAR-DESSUS index.html, onglet « Scanner test »
// ═════════════════════════════════════════════════════════════════════════════════════════
// Les bancs précédents mesuraient la détection et l'identification. Celui-ci mesure ce qui
// n'avait jamais été chiffré : le TEMPS entre le moment où la carte est présentée et celui
// où la capture part, et surtout QUEL verrou fait attendre.
//
// Principe, et c'est le point important : on ne réimplémente rien. On remplace le flux de la
// caméra par un flux synthétique fabriqué à partir de vraies photos du catalogue, et c'est la
// boucle du scanner de test — stTourner, ses seuils, ses états — qui tourne telle quelle. Un
// banc qui recopie la logique qu'il mesure finit toujours par mesurer autre chose : ça nous
// est arrivé entre banc-cadrage et bench-v2, qui se contredisent encore aujourd'hui sur la
// détection à distance.
//
// Ce que ce banc mesure sans modèle : le score du détecteur en fonction de la taille de la
// carte dans l'image, sur de vraies photos et de vrais fonds. C'est de la mesure pure.
// Ce qu'il mesure AVEC un modèle : le délai de déclenchement, qui dépend d'un tremblement de
// main simulé. Les paramètres de ce tremblement sont une hypothèse, pas une observation — les
// chiffres qui en sortent valent en comparatif (tel seuil contre tel autre), pas en absolu.

(function(){
'use strict';

const B = {};
window.BANCD = B;

const H = 1440, L = 1080;                    // scène en portrait, comme un téléphone
const RATIO = 88/63;

// ── Le catalogue, ordinaires et spéciales à parts égales ────────────────────────────────
// Les spéciales — full art, SAR, or — n'ont pas de bordure blanche et sont les plus dures
// pour un détecteur de contours. Les diluer dans la masse donnerait un banc qui ne mesure
// que le cas facile. Faute de rareté dans le catalogue, on les repère au numéro au-delà du
// total imprimé du set.
B.tirer = function(n){
  const tout = SCAN_V2.catalogueV2().filter(c => c.image);
  const parSet = {};
  for(const k of tout){
    const num = parseInt(String(k.numero).replace(/D/g, ''), 10);
    if(Number.isFinite(num)) (parSet[k.setId] = parSet[k.setId] || []).push({...k, n:num});
  }
  const speciales = [];
  for(const l of Object.values(parSet)){
    if(l.length < 40) continue;
    const max = Math.max(...l.map(x => x.n));
    for(const k of l) if(k.n > max*0.88) speciales.push(k);
  }
  const cleSp = new Set(speciales.map(x => x.cle));
  const ordinaires = tout.filter(k => !cleSp.has(k.cle));
  const pioche = (l) => l[Math.floor(Math.random()*l.length)];
  const out = [];
  for(let i = 0; i < n; i++){
    const sp = i % 2 === 1;
    out.push({...pioche(sp ? speciales : ordinaires), speciale: sp});
  }
  return out;
};

B.image = function(base){
  const url = /\.(webp|png|jpg|jpeg)$/i.test(base) ? base : base + '/high.webp';
  return new Promise((res, rej) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = ()=>res(i); i.onerror = ()=>rej(new Error('image indisponible'));
    i.src = url;
  });
};

// ── Les fonds ───────────────────────────────────────────────────────────────────────────
// banc-cadrage a montré que les cartes spéciales ne perdent des points que sur bois et sur
// fond encombré : c'est le contraste avec le fond qui décide, pas l'illustration. On garde
// donc les trois, et on ne moyenne pas dessus sans le dire.
const FONDS = {
  sombre(g){ g.fillStyle = '#14161a'; g.fillRect(0,0,L,H); },
  bois(g){
    g.fillStyle = '#6b4a2f'; g.fillRect(0,0,L,H);
    for(let y = 0; y < H; y += 9){
      g.fillStyle = 'rgba(0,0,0,' + (0.03 + Math.random()*0.05).toFixed(3) + ')';
      g.fillRect(0, y, L, 4 + Math.random()*3);
    }
  },
  encombre(g){
    g.fillStyle = '#4a4640'; g.fillRect(0,0,L,H);
    for(let i = 0; i < 26; i++){
      g.save();
      g.translate(Math.random()*L, Math.random()*H);
      g.rotate((Math.random()-0.5)*1.6);
      g.fillStyle = ['#8a7f6b','#5d6b7a','#7a5d5d','#3f4a3f'][i%4];
      g.fillRect(-90, -60, 180 + Math.random()*160, 120 + Math.random()*90);
      g.restore();
    }
  },
};
B.FONDS = FONDS;

// ── Poser une carte, et rendre les coins qui vont avec ──────────────────────────────────
// hFrac : hauteur de la carte rapportée à la hauteur de l'image. C'est la grandeur que le
// repère de visée exprime, donc celle qu'il faut balayer pour savoir où le placer.
function poser(g, img, o){
  const h = H*o.hFrac, l = h/RATIO;
  g.save();
  g.translate(o.cx*L, o.cy*H);
  g.rotate(o.angle || 0);
  // Ombre portée : sans elle, la carte flotte et le détecteur travaille sur un contraste
  // que la vraie vie ne lui offre jamais.
  g.fillStyle = 'rgba(0,0,0,.42)';
  g.fillRect(-l/2 + 7, -h/2 + 9, l, h);
  g.drawImage(img, -l/2, -h/2, l, h);
  g.restore();
  const coin = (dx, dy) => {
    const x = dx*l/2, y = dy*h/2, a = o.angle || 0;
    return [o.cx + (x*Math.cos(a) - y*Math.sin(a))/L,
            o.cy + (x*Math.sin(a) + y*Math.cos(a))/H];
  };
  return { tl:coin(-1,-1), tr:coin(1,-1), br:coin(1,1), bl:coin(-1,1) };
}
B.poser = poser;

// ── Une détection, exactement comme la boucle du scanner la fait ────────────────────────
// Même redimensionnement, même worker, même appel. Rien d'approché.
async function detecter(source, sw, sh){
  const e = Math.min(1, DETECT_LONG_EDGE / Math.max(sw, sh));
  const bmp = await createImageBitmap(source, {
    resizeWidth: Math.round(sw*e), resizeHeight: Math.round(sh*e), resizeQuality:'medium' });
  return await detectWorkerCall('detect', {bitmap:bmp}, [bmp]);
}
B.detecter = detecter;

const ecart = (a, b) => {
  let m = 0;
  for(const k of ['tl','tr','br','bl'])
    m = Math.max(m, Math.hypot(a[k][0]-b[k][0], a[k][1]-b[k][1]));
  return m;
};
B.ecart = ecart;

// ═════════════════════════════════════════════════════════════════════════════════════════
// MESURE 1 — LE SCORE EN FONCTION DE LA TAILLE. Sans modèle, sans hypothèse.
// ═════════════════════════════════════════════════════════════════════════════════════════
// Elle répond à deux questions d'un coup :
//   • où placer le repère de visée — la taille où le score est franchement au-dessus des seuils
//   • si ST_SCORE_STRICT (0.5, exigé pendant les 1200 premières millisecondes) est atteint
//     d'emblée, ou s'il condamne chaque scan à attendre la détente du seuil
B.scores = async function(opts){
  const o = Object.assign({ n:24, tailles:[0.30,0.40,0.50,0.60,0.70,0.80,0.90],
                            fonds:['sombre','bois','encombre'], angle:0.05, log:true }, opts||{});
  const cartes = B.tirer(o.n);
  const sc = document.createElement('canvas'); sc.width = L; sc.height = H;
  const g = sc.getContext('2d');
  const res = [];
  let i = 0;
  for(const c of cartes){
    i++;
    let img; try{ img = await B.image(c.image); }
    catch(e){ if(o.log) console.log('  image indisponible : ' + c.cle); continue; }
    const fond = o.fonds[i % o.fonds.length];
    for(const t of o.tailles){
      FONDS[fond](g);
      const vrais = poser(g, img, { cx:0.5, cy:0.5, hFrac:t, angle:o.angle });
      let d = null;
      try{ d = await detecter(sc, L, H); }catch(e){}
      res.push({ cle:c.cle, speciale:c.speciale, fond, taille:t,
                 score: d && d.score != null ? d.score : 0,
                 err: d && d.corners ? ecart(d.corners, vrais) : null });
    }
    if(o.log && i % 6 === 0) console.log('  ' + i + '/' + cartes.length + ' cartes…');
  }
  B.dernierScores = res;
  if(o.log) B.rapportScores(res);
  return res;
};

const med = a => { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
const pct = (a, f) => a.length ? Math.round(100*a.filter(f).length/a.length) : 0;

B.rapportScores = function(res){
  res = res || B.dernierScores;
  console.log('\n── SCORE DU DÉTECTEUR PAR TAILLE DE CARTE ' + '─'.repeat(30));
  console.log('taille  n    médiane   ≥0,50   ≥0,35   err.méd   (≥0,50 = déclenche tout de suite)');
  const tailles = [...new Set(res.map(r => r.taille))].sort((a,b)=>a-b);
  for(const t of tailles){
    const l = res.filter(r => r.taille === t);
    const errs = l.filter(r => r.err != null).map(r => r.err);
    console.log('  ' + t.toFixed(2) + '  ' + String(l.length).padStart(3)
      + '     ' + med(l.map(r=>r.score)).toFixed(2)
      + '     ' + String(pct(l, r=>r.score>=0.50)).padStart(3) + '%'
      + '    ' + String(pct(l, r=>r.score>=0.35)).padStart(3) + '%'
      + '     ' + (errs.length ? med(errs).toFixed(3) : '  —  '));
  }
  for(const clef of ['speciale','fond']){
    console.log('\n  par ' + clef + ' :');
    const vals = [...new Set(res.map(r => r[clef]))];
    for(const v of vals){
      const l = res.filter(r => r[clef] === v);
      console.log('    ' + String(v).padEnd(10) + ' médiane ' + med(l.map(r=>r.score)).toFixed(2)
        + ' · ≥0,50 ' + String(pct(l, r=>r.score>=0.50)).padStart(3) + '%'
        + ' · ≥0,35 ' + String(pct(l, r=>r.score>=0.35)).padStart(3) + '%');
    }
  }
};

// ═════════════════════════════════════════════════════════════════════════════════════════
// MESURE 2 — LE DÉLAI DE DÉCLENCHEMENT, SUR LE VRAI CODE
// ═════════════════════════════════════════════════════════════════════════════════════════
// On remplace le flux caméra par un flux synthétique et on laisse tourner stTourner. Les
// états publiés par stViser disent lequel des verrous fait attendre :
//     « je cherche… »  → le score n'atteint pas le seuil exigé
//     « stabilise »    → le mouvement dépasse le seuil
//     « trop loin »    → la carte est sous le plancher d'aire
// ⚠️ Le tremblement est un MODÈLE. Ses chiffres valent en comparatif, pas en absolu.
const TREMBLEMENT = {
  balancement: { amp:0.010, hz:0.8 },   // dérive lente du poignet
  physio:      { amp:0.0025, hz:6 },    // tremblement physiologique
  approche:    0.45,                     // constante de temps de la mise en place, secondes
};
B.TREMBLEMENT = TREMBLEMENT;

B.declenchement = async function(opts){
  const o = Object.assign({ n:20, taille:0.62, fond:'bois', limiteMs:5000, log:true }, opts||{});
  const cartes = B.tirer(o.n);
  const sc = document.createElement('canvas'); sc.width = L; sc.height = H;
  const g = sc.getContext('2d');
  const v = $('st-video');

  // On garde de quoi tout remettre en place : ce banc touche à l'état du scanner.
  const sauve = { srcObject: v.srcObject, capturer: window.stCapturer, viser: window.stViser,
                  boucle: ST.boucle };

  const trace = [];
  window.stViser = function(coins, etat, texte){
    trace.push({ t: performance.now(), etat: coins ? etat : 'rien', texte: texte || null });
    return sauve.viser.apply(this, arguments);
  };
  // La capture est court-circuitée : ce banc mesure le DÉCLENCHEMENT, pas l'identification,
  // qui est déjà mesurée ailleurs et coûterait plusieurs secondes de réseau par carte.
  let declenche = null;
  window.stCapturer = async function(){ declenche = performance.now(); };

  // Peindre AVANT de capter. Un canevas vierge ne produit aucune image, la piste reste sans
  // métadonnées, et stTourner attend indéfiniment sur `!v.videoWidth` — le banc rendrait
  // alors « 0 % de déclenchement » avec l'aplomb d'un résultat. On vérifie donc que le flux
  // vit vraiment avant de mesurer quoi que ce soit.
  FONDS[o.fond](g);
  // captureStream(0) et non (30) : à cadence libre, le canevas est capté quand il veut, donc
  // parfois ENTRE l'effacement du fond et le dessin de la carte. On récoltait alors des
  // images vides ou à moitié peintes, comptées comme « le détecteur ne voit rien » — 128 tours
  // sur une série de trente, et onze fausses alertes de forme. À zéro, c'est nous qui livrons
  // l'image, une fois qu'elle est finie.
  const flux = sc.captureStream(0);
  const pisteBanc = flux.getVideoTracks()[0];
  v.srcObject = flux;
  try{ await v.play(); }catch(e){}
  try{ pisteBanc.requestFrame(); }catch(e){}
  const tAttente = performance.now();
  while(!v.videoWidth && performance.now() - tAttente < 3000)
    await new Promise(r => setTimeout(r, 50));
  if(!v.videoWidth){
    v.srcObject = sauve.srcObject; window.stCapturer = sauve.capturer; window.stViser = sauve.viser;
    flux.getTracks().forEach(t => t.stop());
    throw new Error('le flux synthétique ne délivre aucune image — rien à mesurer');
  }
  B.progression = [];

  const res = [];
  try{
    for(let i = 0; i < cartes.length; i++){
      const c = cartes[i];
      let img; try{ img = await B.image(c.image); }catch(e){ continue; }

      // État du scanner remis à neuf entre deux cartes, comme après un retrait.
      ST.retiree = true; ST.coinsCapture = null; ST.presentDepuis = 0;
      ST.streak = 0; ST.dernierCoins = null; ST.absence = 2; ST.occupe = false;
      trace.length = 0; declenche = null;

      // Champ vide une demi-seconde : c'est ce qui sépare deux cartes dans la vraie vie, et
      // l'omettre ferait démarrer le chronomètre sur un état déjà à moitié acquis.
      let rafVide = 0;
      const peindreVide = () => { FONDS[o.fond](g);
        try{ pisteBanc.requestFrame(); }catch(e){}
        rafVide = requestAnimationFrame(peindreVide); };
      peindreVide();
      ST.boucle = true; stTourner();
      await new Promise(r => setTimeout(r, 500));
      cancelAnimationFrame(rafVide);

      const t0 = performance.now();
      const depart = { cx: 0.5 + (Math.random()-0.5)*0.12, cy: 0.5 + (Math.random()-0.5)*0.10 };
      const cible  = { cx: 0.5, cy: 0.5 };
      const phi = Math.random()*6.28, angle0 = (Math.random()-0.5)*0.16;
      let raf = 0;
      const peindre = () => {
        const s = (performance.now() - t0)/1000;
        const k = Math.exp(-s/TREMBLEMENT.approche);
        const tr = TREMBLEMENT.balancement.amp*Math.sin(2*Math.PI*TREMBLEMENT.balancement.hz*s + phi)
                 + TREMBLEMENT.physio.amp*Math.sin(2*Math.PI*TREMBLEMENT.physio.hz*s + phi*2);
        FONDS[o.fond](g);
        poser(g, img, {
          cx: cible.cx + (depart.cx-cible.cx)*k + tr,
          cy: cible.cy + (depart.cy-cible.cy)*k + tr*0.6,
          hFrac: o.taille, angle: angle0*k + tr*0.5 });
        // L'image est complète : on la livre maintenant, et seulement maintenant.
        try{ pisteBanc.requestFrame(); }catch(e){}
        raf = requestAnimationFrame(peindre);
      };
      peindre();

      while(declenche == null && performance.now() - t0 < o.limiteMs)
        await new Promise(r => setTimeout(r, 30));
      cancelAnimationFrame(raf);
      ST.boucle = false;
      await new Promise(r => setTimeout(r, 150));   // laisser la boucle sortir

      // À quoi le temps a-t-il été passé : on compte les états publiés avant le déclic.
      // ⚠️ On ne compte QUE les tours postérieurs à t0. Sans ce filtre, les tours passés
      // sur le champ vide intercalé entre deux cartes étaient portés au débit du
      // déclenchement : ma première lecture attribuait ainsi 112 tours à « le détecteur ne
      // voit rien » alors qu'ils mesuraient une attente que j'avais moi-même programmée.
      const avant = trace.filter(x => x.t >= t0 && (declenche == null || x.t <= declenche));
      const compte = {};
      for(const x of avant){ const k = x.texte || x.etat; compte[k] = (compte[k]||0)+1; }
      res.push({ cle:c.cle, speciale:c.speciale,
                 ms: declenche == null ? null : Math.round(declenche - t0),
                 tours: avant.length, verrous: compte });
      B.progression.push(res[res.length-1]);
      if(o.log) console.log('  ' + String(i+1).padStart(3) + '/' + cartes.length + '  '
        + (declenche == null ? 'JAMAIS  ' : String(Math.round(declenche-t0)).padStart(5) + ' ms')
        + '  ' + (c.speciale ? 'spé.' : 'ord.') + '  ' + JSON.stringify(compte));
    }
  } finally {
    window.stCapturer = sauve.capturer; window.stViser = sauve.viser;
    ST.boucle = sauve.boucle; v.srcObject = sauve.srcObject;
    flux.getTracks().forEach(t => t.stop());
  }
  B.dernierDeclenchement = res;
  if(o.log) B.rapportDeclenchement(res);
  return res;
};

B.rapportDeclenchement = function(res){
  res = res || B.dernierDeclenchement;
  const ok = res.filter(r => r.ms != null);
  console.log('\n── DÉLAI DE DÉCLENCHEMENT ' + '─'.repeat(46));
  console.log('  cartes            ' + res.length);
  console.log('  déclenchées       ' + ok.length + ' (' + Math.round(100*ok.length/res.length) + ' %)');
  if(ok.length){
    const t = ok.map(r => r.ms).sort((a,b)=>a-b);
    console.log('  médiane           ' + t[t.length>>1] + ' ms');
    console.log('  min / max         ' + t[0] + ' / ' + t[t.length-1] + ' ms');
    console.log('  sous 1000 ms      ' + pct(ok, r=>r.ms<1000) + ' %');
    console.log('  au-delà de 1500   ' + pct(ok, r=>r.ms>1500) + ' %   (= le seuil s'
      + 'est détendu à 1200 ms, donc un verrou a bloqué)');
  }
  const tot = {};
  for(const r of res) for(const k in r.verrous) tot[k] = (tot[k]||0) + r.verrous[k];
  console.log('\n  tours passés dans chaque état, tous scans confondus :');
  for(const k of Object.keys(tot).sort((a,b)=>tot[b]-tot[a]))
    console.log('    ' + String(k).padEnd(22) + String(tot[k]).padStart(5));
};

console.log('banc de déclenchement chargé — BANCD.scores() puis BANCD.declenchement()');
})();
