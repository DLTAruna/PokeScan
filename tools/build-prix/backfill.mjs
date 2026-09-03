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
// dans la fiche de chaque carte : aucun rapprochement par nom, donc aucune approximation.
//
// Voir README.md pour l'état des lieux complet des sources.
//
// ── DEUX PASSES, ET POURQUOI ─────────────────────────────────────────────────────────
// La première télécharge et réduit chaque journée à un petit fichier ; la seconde assemble
// les séries. Séparer les deux rend la reconstitution REPRENABLE : une journée déjà réduite
// n'est pas retéléchargée. Le premier essai, en une seule passe, s'est fait interrompre au
// bout de trois heures et tout était perdu.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = 'https://tcgcsv.com/archive/tcgplayer';
const CAT_POKEMON = '3';
const AGENT = 'pokescan/1.0 (historique de cotes personnel)';

function args(){
  const a = process.argv.slice(2), o = {};
  for(let i = 0; i < a.length; i++)
    if(a[i].startsWith('--')) o[a[i].slice(2)] = a[i+1] && !a[i+1].startsWith('--') ? a[++i] : true;
  return o;
}

function jours(depuis, jusqu){
  const out = [];
  for(let d = new Date(depuis + 'T00:00:00Z'), f = new Date(jusqu + 'T00:00:00Z'); d <= f;
      d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// ── PASSE 1 : une journée réduite à ses seuls prix Pokémon ────────────────────────────
async function reduireJour(jour, tmp, cmd7z){
  const arch = path.join(tmp, `${jour}.7z`);
  const dest = path.join(tmp, jour);

  // Sans en-tête d'agent, TCGCSV répond 401 : le défaut de Node est refusé. Un nom lisible
  // vaut mieux qu'un déguisement en navigateur — on se présente.
  const r = await fetch(`${BASE}/prices-${jour}.ppmd.7z`, { headers: { 'User-Agent': AGENT } });
  if(!r.ok) return { absent: true, statut: r.status };
  fs.writeFileSync(arch, Buffer.from(await r.arrayBuffer()));

  // N'extraire QUE la catégorie 3. Déplier l'archive entière donnait deux cent mille petits
  // fichiers et quatre-vingt-sept mégaoctets par journée : sous Windows, entre la création,
  // l'analyse antivirus et l'effacement, une journée passait de deux secondes à neuf
  // MINUTES — mesuré, la reconstitution complète aurait pris six jours. Ciblée, c'est deux
  // cent vingt fichiers et huit mégaoctets.
  await new Promise((ok, ko) =>
    cmd7z(['x', arch, '-o' + dest, `${jour}/${CAT_POKEMON}/*`, '-r', '-y'],
          e => e ? ko(e) : ok()));
  fs.rmSync(arch, { force: true });

  const racine = path.join(dest, jour, CAT_POKEMON);
  const releves = {};
  if(fs.existsSync(racine)){
    for(const groupe of fs.readdirSync(racine)){
      const f = path.join(racine, groupe, 'prices');
      if(!fs.existsSync(f)) continue;
      let j; try{ j = JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ continue; }
      for(const p of (j.results || [])){
        // `marketPrice` est le prix de marché du jour ; les autres champs décrivent les
        // annonces en cours, pas une transaction.
        if(!(p.marketPrice > 0)) continue;
        releves[p.productId + '|' + (p.subTypeName || 'Normal')] = p.marketPrice;
      }
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { releves };
}

// ── LE TAUX DE CHANGE, JOUR PAR JOUR ─────────────────────────────────────────────────
// Les archives TCGCSV sont en dollars. Les convertir au taux d'AUJOURD'HUI serait une
// faute : l'euro a bougé de plusieurs pour cent sur la période, et cette variation-là se
// retrouverait dans la courbe comme si la carte l'avait faite. On prend donc le taux du
// jour de chaque relevé.
//
// Source : le service de données de la BCE, taux de référence quotidien, gratuit et sans
// clé. Il fait autorité — Frankfurter, souvent cité, n'en est qu'un miroir : vérifié, les
// deux donnent 1,1662 dollar pour un euro au 25 août 2026.
//
// La BCE ne publie que les jours ouvrés. Les week-ends et fériés reprennent le dernier taux
// connu : c'est ce que fait n'importe quelle comptabilité, et une carte vendue un dimanche
// l'est bien au taux du vendredi.
async function tauxEuro(depuis, jusqu){
  const url = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A'
    + '?startPeriod=' + depuis + '&endPeriod=' + jusqu + '&format=csvdata';
  const r = await fetch(url, { headers: { 'User-Agent': AGENT } });
  if(!r.ok) throw new Error('taux BCE indisponibles (HTTP ' + r.status + ')');
  const lignes = (await r.text()).split('\n');
  const tete = lignes[0].split(',');
  const iJour = tete.indexOf('TIME_PERIOD'), iVal = tete.indexOf('OBS_VALUE');
  const brut = new Map();
  for(const l of lignes.slice(1)){
    const c = l.split(',');
    const v = parseFloat(c[iVal]);
    if(c[iJour] && v > 0) brut.set(c[iJour], v);
  }
  if(!brut.size) throw new Error('aucun taux reçu de la BCE');
  return brut;
}

async function main(){
  const o = args();
  const depuis = o.depuis || '2024-02-08';
  const jusqu  = o.jusqu  || new Date().toISOString().slice(0, 10);
  const sortie = o.sortie || './prix';
  const { cmd: cmd7z } = require('7zip-min');

  const liste = jours(depuis, jusqu);
  const dJours = path.join(sortie, 'jours');
  const tmp = path.join(sortie, 'tmp');
  fs.mkdirSync(dJours, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  console.log(`${liste.length} journées, du ${depuis} au ${jusqu}`);

  // ── PASSE 1 ─────────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  let faits = 0, repris = 0, absents = 0;
  for(const [i, jour] of liste.entries()){
    const cible = path.join(dJours, `${jour}.json`);
    if(fs.existsSync(cible)){ repris++; continue; }
    let r;
    try{ r = await reduireJour(jour, tmp, cmd7z); }
    catch(e){ console.log(`  ${jour} : échec — ${e.message}`); continue; }
    if(r.absent){ absents++; fs.writeFileSync(cible, '{}'); continue; }
    fs.writeFileSync(cible, JSON.stringify(r.releves));
    faits++;
    if(faits % 25 === 0){
      const par = (Date.now() - t0) / faits;
      const reste = Math.round(par * (liste.length - i - 1) / 1000);
      console.log(`  ${jour} — ${i+1}/${liste.length}, ${Math.round(par)} ms/jour, `
        + `reste ~${Math.floor(reste/60)} min`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passe 1 : ${faits} téléchargées, ${repris} déjà là, ${absents} absentes`);

  // ── PASSE 2 : assemblage ────────────────────────────────────────────────────────────
  // Une série par produit et par impression, en Float32 : quarante-cinq mille séries sur
  // mille journées tiennent ainsi dans moins de deux cents mégaoctets, là où des tableaux
  // d'objets auraient débordé la mémoire.
  const presents = liste.filter(j => fs.existsSync(path.join(dJours, `${j}.json`)));
  const n = presents.length;

  // ── LA CONVERSION SE FAIT À L'AFFICHAGE, PAS ICI ──────────────────────────────────
  // Convertir dès la reconstitution donnait un résultat juste mais deux fois plus lourd, et
  // pour une raison qui vaut d'être notée : en dollars, une carte dont le prix ne bouge pas
  // pendant trois semaines s'écrit une valeur et vingt nulls ; en euros, le taux bougeant
  // chaque jour, les vingt et un jours deviennent vingt et une valeurs différentes. La
  // compression par répétition, qui divise le poids par plusieurs, ne mordait plus.
  //
  // On publie donc les séries en dollars — telles que la source les donne, compressées — et
  // À CÔTÉ la table des taux quotidiens, alignée sur le même index de jours. Neuf cent
  // trente-huit nombres, quelques kilo-octets, partagés par les quarante-cinq mille séries.
  // L'application divise à l'affichage : les euros sont exacts au jour près, on garde la
  // possibilité de montrer les dollars, et rien n'est recalculé si un taux est corrigé.
  //
  // `--devise eur` reste possible pour figer les euros dans les fichiers, mais ce n'est plus
  // le défaut.
  const enEuros = String(o.devise || '').toLowerCase() === 'eur';
  const taux = new Array(n).fill(null);
  {
    const brut = await tauxEuro(depuis, jusqu);
    let dernier = null;
    for(const [i, jour] of presents.entries()){
      if(brut.has(jour)) dernier = brut.get(jour);
      taux[i] = dernier;
    }
    // Les tout premiers jours peuvent précéder le premier taux publié : on les rattrape
    // avec le plus ancien connu plutôt que de les perdre.
    const premier = taux.find(t => t != null);
    for(let i = 0; i < n && taux[i] == null; i++) taux[i] = premier;
    console.log('taux BCE : ' + brut.size + ' jours ouvrés, '
      + taux.filter(t => t != null).length + '/' + n + ' journées couvertes');
  }

  const series = new Map();
  for(const [i, jour] of presents.entries()){
    let j; try{ j = JSON.parse(fs.readFileSync(path.join(dJours, `${jour}.json`), 'utf8')); }
    catch(e){ continue; }
    for(const cle in j){
      let s = series.get(cle);
      if(!s){ s = new Float32Array(n).fill(NaN); series.set(cle, s); }
      // Le taux BCE s'exprime en dollars POUR UN euro : on divise.
      s[i] = enEuros && taux[i] ? j[cle] / taux[i] : j[cle];
    }
  }
  console.log(`passe 2 : ${series.size} séries sur ${n} journées, en `
    + (enEuros ? 'euros' : 'dollars'));

  // Une valeur n'est écrite que si elle CHANGE — un prix bouge rarement d'un jour à l'autre,
  // et sans cela un an pèserait 252 mégaoctets. À la lecture, null signifie « comme la
  // veille », ce qui vaut aussi pour une journée sans relevé : les deux cas se confondent.
  // Réparti par le reste de la division du productId : l'application n'en télécharge qu'un
  // pour la carte qu'elle affiche, au lieu d'un index unique énorme.
  //
  // Mille vingt-quatre paquets et non deux cent cinquante-six : sur trente et un mois, la
  // première répartition donnait des paquets de 743 Ko — acceptable sur une fibre, pesant
  // sur un téléphone en boutique, pour lire UNE carte. À mille vingt-quatre, chaque paquet
  // tombe sous les deux cents kilo-octets et porte encore une quarantaine de séries : les
  // cartes voisines d'un même lot profitent souvent du même téléchargement.
  const N_PAQUETS = +(o.paquets || 1024);
  const paquets = new Map();
  for(const [cle, s] of series){
    let i0 = 0; while(i0 < n && Number.isNaN(s[i0])) i0++;
    if(i0 === n) continue;
    let i1 = n - 1; while(i1 > i0 && Number.isNaN(s[i1])) i1--;
    const v = []; let prec = null;
    for(let i = i0; i <= i1; i++){
      const x = Number.isNaN(s[i]) ? null : Math.round(s[i] * 100) / 100;
      if(x === null || x === prec) v.push(null); else { v.push(x); prec = x; }
    }
    const p = parseInt(cle, 10) % N_PAQUETS;
    const b = paquets.get(p) || (paquets.set(p, {}), paquets.get(p));
    b[cle] = { d: presents[i0], v };
  }
  for(const [p, contenu] of paquets)
    fs.writeFileSync(path.join(sortie, `${p}.json`), JSON.stringify(contenu));

  // La table des taux, alignée sur le même index que les séries : `d` est la première
  // journée, `v[i]` le nombre de dollars pour un euro ce jour-là. Prix en euros =
  // prix en dollars / v[i].
  fs.writeFileSync(path.join(sortie, 'taux.json'), JSON.stringify({
    source: 'BCE, taux de référence quotidien USD/EUR',
    sens: 'dollars pour un euro — diviser un prix en dollars par cette valeur',
    d: presents[0], v: taux.map(t => t == null ? null : +t.toFixed(4))
  }));

  const octets = fs.readdirSync(sortie)
    .filter(f => f.endsWith('.json'))
    .reduce((s, f) => s + fs.statSync(path.join(sortie, f)).size, 0);
  console.log(`${paquets.size} paquets, ${(octets/1048576).toFixed(1)} Mo `
    + `(${Math.round(octets/paquets.size/1024)} Ko par paquet)`);
  console.log(`durée totale : ${Math.round((Date.now()-t0)/60000)} min`);
}

main().catch(e => { console.error(e); process.exit(1); });
