// Stockage des packs de reconnaissance visuelle (embeddings + descripteurs ORB d'un set).
//
// Personne ne manipule de fichier. Le premier appareil qui ouvre un set sans pack le
// construit localement (une fois, ~5 min) puis l'ENVOIE ici (POST). Tous les suivants le
// TÉLÉCHARGENT (GET) en quelques secondes, sans aucun calcul.
//
// Stockage : le même gist privé que les logs (variables GIST_TOKEN / GIST_ID), un fichier
// binaire encodé base64 par set : `pack-<set>.b64`. Suffisant pour la phase de test ; pour
// le catalogue entier, basculer vers un vrai stockage d'objets (Supabase Storage / Vercel
// Blob) en ne changeant que ce fichier.

const MAX_BYTES = 9 * 1024 * 1024;   // garde-fou : un pack de ~200 cartes fait ~5 Mo

export default async function handler(req, res) {
  const TOKEN = process.env.GIST_TOKEN;
  const GIST_ID = process.env.GIST_ID;
  if (!TOKEN || !GIST_ID) { res.status(500).json({ error: 'GIST_TOKEN / GIST_ID non configurés' }); return; }

  const set = String((req.query && req.query.set) || '').trim();
  if (!set || !/^[\w.-]{1,40}$/.test(set)) { res.status(400).json({ error: 'paramètre ?set invalide' }); return; }
  const FILE = `pack-${set}.b64`;

  const gh = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pokescan-pack-store',
  };

  try {
    if (req.method === 'GET') {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gh });
      if (!r.ok) { res.status(502).json({ error: 'lecture gist', status: r.status }); return; }
      const gist = await r.json();
      const f = gist.files && gist.files[FILE];
      if (!f) { res.status(404).json({ error: 'pas de pack pour ' + set }); return; }
      // GitHub tronque le contenu inline au-delà de ~1 Mo : on suit `raw_url` le cas échéant.
      let b64 = f.content;
      if (f.truncated && f.raw_url) b64 = await (await fetch(f.raw_url, { headers: gh })).text();
      const buf = Buffer.from(b64, 'base64');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      res.status(200).send(buf);
      return;
    }

    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) { chunks.push(c); if (Buffer.concat(chunks).length > MAX_BYTES) { res.status(413).json({ error: 'pack trop volumineux' }); return; } }
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) { res.status(400).json({ error: 'corps vide' }); return; }

      // On n'écrase PAS un pack déjà présent (le premier envoi fait foi ; ça évite qu'un
      // appareil avec un index bancal remplace un bon pack).
      const cur = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gh });
      if (cur.ok) {
        const g = await cur.json();
        if (g.files && g.files[FILE]) { res.status(200).json({ ok: true, existait: true }); return; }
      }

      const patch = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { ...gh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [FILE]: { content: buf.toString('base64') } } }),
      });
      if (!patch.ok) { res.status(502).json({ error: 'écriture gist', status: patch.status, github: await patch.text() }); return; }
      res.status(200).json({ ok: true, bytes: buf.length });
      return;
    }

    res.status(405).json({ error: 'méthode non supportée' });
  } catch (err) {
    res.status(500).json({ error: 'exception', message: err.message });
  }
}

// Vercel : recevoir le corps brut (pas de parsing JSON automatique).
export const config = { api: { bodyParser: false } };
