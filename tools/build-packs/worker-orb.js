// Cloudflare Worker optionnel — regroupe la récupération des descripteurs ORB.
//
// Sans lui, le client fait ~18 requêtes séparées à R2 par scan (une par carte de la
// shortlist) : ~250-400 ms sur mobile, surtout de la latence de connexion. Avec lui, une
// seule requête ; le Worker lit R2 côté edge (gratuit, même colo, ~0 ms) et renvoie tout
// concaténé.
//
// DÉPLOIEMENT (dashboard, sans CLI) :
//   1. Cloudflare → Workers & Pages → Create → Worker → nom « pokescan-orb » → Deploy
//   2. Ouvre le Worker → Edit code → colle ce fichier → Deploy
//   3. Settings → Bindings → + Add → R2 bucket → nom de variable EXACTEMENT « PACKS »,
//      bucket « pokescan-packs » → Save and deploy
//   4. Copie l'URL (https://pokescan-orb.<ton-sous-domaine>.workers.dev) et donne-la :
//      elle va dans scan-v2.js (const WORKER_ORB).
//
// Réponse : [uint16 LE n] puis n fois { [uint8 lenClé][clé UTF-8][uint32 LE lenBlob][blob] }
// lenBlob = 0 → carte absente.

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const cles = (url.searchParams.get('k') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 48);
    if (!cles.length) return new Response('paramètre ?k= manquant', { status: 400, headers: cors });

    const morceaux = await Promise.all(cles.map(async k => {
      if (!/^[\w.-]{1,60}$/.test(k)) return { k, buf: null };
      try { const o = await env.PACKS.get('orb/' + k + '.orb'); return { k, buf: o ? new Uint8Array(await o.arrayBuffer()) : null }; }
      catch (e) { return { k, buf: null }; }
    }));

    let taille = 2;
    for (const m of morceaux) taille += 1 + m.k.length + 4 + (m.buf ? m.buf.length : 0);
    const out = new Uint8Array(taille);
    const dv = new DataView(out.buffer);
    let p = 0;
    dv.setUint16(p, morceaux.length, true); p += 2;
    for (const m of morceaux) {
      out[p++] = m.k.length;
      for (let i = 0; i < m.k.length; i++) out[p++] = m.k.charCodeAt(i) & 0xff;
      dv.setUint32(p, m.buf ? m.buf.length : 0, true); p += 4;
      if (m.buf) { out.set(m.buf, p); p += m.buf.length; }
    }
    return new Response(out, { headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=604800' } });
  },
};
