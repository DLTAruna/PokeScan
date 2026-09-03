// Reconstitution de l'historique des cotes à partir des archives TCGCSV.
//
// TCGCSV publie, pour chaque jour depuis le 8 février 2024, l'intégralité des relevés de
// prix TCGplayer — sans clé, sans compte. C'est la seule source gratuite vérifiée qui
// conserve VRAIMENT ses journées passées : Cardmarket, lui, ne publie que la nuit en cours
// (ses URL datées répondent 403), et les revendeurs d'API réservent l'historique à leurs
// offres payantes.
//
// On ne garde que la catégorie 3 — le Pokémon — et, de chaque relevé, le prix de marché.
// Le résultat est indexé par `productId`, l'identifiant TCGplayer que TCGdex publie déjà
// dans la fiche de chaque carte : aucun rapprochement par nom n'est nécessaire, donc aucune
// approximation.
//
// Voir README.md pour l'état des lieux complet des sources.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const BASE = 'https://tcgcsv.com/archive/tcgplayer';
const CATEGORIE_POKEMON = '3';

function args(){
  const a = process.argv.slice(2), o = {};
  for(let i = 0; i < a.length; i++){
    if(a[i].startsWith('--')) o[a[i].slice(2)] = a[i+1] && !a[i+1].startsWith('--') ? a[++i] : true;
  }
  return o;
}

function jours(depuis, jusqu){
  const out = [];
  for(let d = new Date(depuis + 'T00:00:00Z'), f = new Date(jusqu + 'T00:00:00Z'); d <= f;
      d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// Une journée : téléchargement, décompression, extraction, puis effacement immédiat du
// temporaire. Quatre-vingt-sept mégaoctets par jour décompressés — les garder ferait
// cinquante gigaoctets sur un an pour des données dont on ne veut qu'un centième.
async function unJour(jour, dossierTmp, unpack){
  const url = `${BASE}/prices-${jour}.ppmd.7z`;
  const arch = path.join(dossierTmp, `${jour}.7z`);
  const dest = path.join(dossierTmp, jour);

  // Sans en-tête d'agent, TCGCSV répond 401 : le défaut de Node est refusé. Un nom lisible
  // et un contact valent mieux qu'un déguisement en navigateur — on se présente.
  const r = await fetch(url, { headers: { 'User-Agent': 'pokescan/1.0 (historique de cotes personnel)' } });
  if(!r.ok) return { jour, absent: true, statut: r.status };
  fs.writeFileSync(arch, Buffer.from(await r.arrayBuffer()));

  await new Promise((ok, ko) => unpack(arch, dest, e => e ? ko(e) : ok()));
  fs.rmSync(arch, { force: true });

  // L'archive se déplie en <date>/<catégorie>/<groupe>/prices.
  const racine = path.join(dest, jour, CATEGORIE_POKEMON);
  const releves = new Map();
  if(fs.existsSync(racine)){
    for(const groupe of fs.readdirSync(racine)){
      const f = path.join(racine, groupe, 'prices');
      if(!fs.existsSync(f)) continue;
      let j;
      try{ j = JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ continue; }
      for(const p of (j.results || [])){
        // `marketPrice` est le prix de marché du jour ; les autres champs décrivent les
        // annonces en cours, pas une transaction. Une seule valeur par produit et par
        // impression : c'est ce qui fait une série lisible.
        if(!(p.marketPrice > 0)) continue;
        const cle = p.productId + '|' + (p.subTypeName || 'Normal');
        releves.set(cle, p.marketPrice);
      }
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { jour, releves };
}

async function main(){
  const o = args();
  const depuis = o.depuis || '2025-09-01';
  const jusqu  = o.jusqu  || new Date().toISOString().slice(0, 10);
  const sortie = o.sortie || './prix';
  const { unpack } = require('7zip-min');

  const liste = jours(depuis, jusqu);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prix-'));
  console.log(`${liste.length} journées, du ${depuis} au ${jusqu}`);
  console.log(`temporaire : ${tmp}`);

  // series : "productId|impression" -> [{j, v}]
  const series = new Map();
  const vus = new Set();          // les journées réellement obtenues
  let ok = 0, absents = 0;
  const t0 = Date.now();

  for(const [i, jour] of liste.entries()){
    let r;
    try{ r = await unJour(jour, tmp, unpack); }
    catch(e){ console.log(`  ${jour} : échec — ${e.message}`); continue; }
    if(r.absent){ absents++; console.log(`  ${jour} : absent (${r.statut})`); continue; }
    for(const [cle, v] of r.releves){
      const s = series.get(cle) || (series.set(cle, []), series.get(cle));
      s.push({ j: jour, v });
    }
    vus.add(jour);
    ok++;
    const ecoule = (Date.now() - t0) / 1000;
    const reste = Math.round(ecoule / (i + 1) * (liste.length - i - 1));
    console.log(`  ${jour} : ${r.releves.size} relevés  (${i+1}/${liste.length}, `
      + `reste ~${Math.floor(reste/60)} min ${reste%60} s)`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(sortie, { recursive: true });

  // Encodage compact, et ce n'est pas un détail : une série de dates et de valeurs écrites
  // en toutes lettres pèse vingt-six octets par jour et par produit, soit quatre cents
  // mégaoctets pour un an. Ici, une date de départ et un tableau de valeurs dont la position
  // EST le jour — les jours sans relevé valent null. On tombe à cinq octets par point.
  //
  // Réparti en 256 fichiers par le reste de la division du productId : l'application n'en
  // télécharge qu'un pour la carte qu'elle affiche, au lieu d'un index unique énorme.
  const tousJours = liste.filter(j => vus.has(j));
  const rang = new Map(tousJours.map((j, i) => [j, i]));
  const paquets = new Map();
  for(const [cle, pts] of series){
    if(!pts.length) continue;
    const i0 = rang.get(pts[0].j), i1 = rang.get(pts[pts.length - 1].j);
    const v = new Array(i1 - i0 + 1).fill(null);
    for(const p of pts) v[rang.get(p.j) - i0] = p.v;
    // Une valeur n'est écrite que si elle CHANGE. Un prix de carte bouge rarement d'un jour
    // à l'autre — sur quatre jours de relevés, la plupart des séries répètent le même nombre
    // quatre fois. Écrire null quand rien ne change fait tomber un an de 252 à quelques
    // dizaines de mégaoctets. À la lecture, null signifie « comme la veille » : c'est aussi
    // ce qu'on veut d'une journée sans relevé, donc les deux cas se traitent pareil.
    let precedent = null;
    for(let i = 0; i < v.length; i++){
      if(v[i] == null) continue;
      if(v[i] === precedent) v[i] = null; else precedent = v[i];
    }
    const paquet = parseInt(cle, 10) % 256;
    const b = paquets.get(paquet) || (paquets.set(paquet, {}), paquets.get(paquet));
    b[cle] = { d: tousJours[i0], v };
  }
  for(const [p, contenu] of paquets)
    fs.writeFileSync(path.join(sortie, `${p}.json`), JSON.stringify(contenu));

  const octets = fs.readdirSync(sortie)
    .reduce((s, f) => s + fs.statSync(path.join(sortie, f)).size, 0);
  console.log(`\n${ok} journées retenues, ${absents} absentes`);
  console.log(`${series.size} séries (produit × impression)`);
  console.log(`${paquets.size} fichiers, ${(octets/1048576).toFixed(1)} Mo au total`);
  console.log(`durée : ${Math.round((Date.now()-t0)/1000)} s`);
}

main().catch(e => { console.error(e); process.exit(1); });
