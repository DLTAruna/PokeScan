// Petit canal de pilotage entre la page build.html et le script de construction des packs
// qui tourne ailleurs. La page POSTe une commande (relancer un set, en passer un, tout
// reprendre, stopper) ; le script la lit en GET entre deux cartes et l'exécute, puis la
// remet à vide.
//
// Stockage : le même gist privé que les logs (GIST_TOKEN / GIST_ID), fichier
// `build-control.json`. Aucune donnée sensible ; c'est juste un drapeau.

const COMMANDES = ['', 'restart-set', 'skip-set', 'rebuild-all', 'stop'];
const FILE = 'build-control.json';

export default async function handler(req, res) {
  const TOKEN = process.env.GIST_TOKEN;
  const GIST_ID = process.env.GIST_ID;
  if (!TOKEN || !GIST_ID) { res.status(500).json({ error: 'GIST_TOKEN / GIST_ID non configurés' }); return; }

  const gh = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pokescan-build-control',
  };

  // CORS : la page est servie depuis le même domaine, mais le script de build, lui, est ailleurs.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gh });
      if (!r.ok) { res.status(502).json({ error: 'lecture gist', status: r.status }); return; }
      const gist = await r.json();
      const f = gist.files && gist.files[FILE];
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(f ? JSON.parse(f.content || '{}') : {});
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      const command = String(body.command || '');
      if (!COMMANDES.includes(command)) { res.status(400).json({ error: 'commande inconnue', attendu: COMMANDES }); return; }
      const payload = { command, target: body.target ? String(body.target) : null, ts: Date.now() };

      const patch = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { ...gh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(payload) } } }),
      });
      if (!patch.ok) { res.status(502).json({ error: 'écriture gist', status: patch.status }); return; }
      res.status(200).json({ ok: true, ...payload });
      return;
    }

    res.status(405).json({ error: 'méthode non supportée' });
  } catch (err) {
    res.status(500).json({ error: 'exception', message: err.message });
  }
}
