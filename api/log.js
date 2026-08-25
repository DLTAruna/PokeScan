// Relais de diagnostic : le téléphone POST ses observations ici, elles sont ajoutées
// à un Gist GitHub privé (le seul stockage persistant disponible sans base de données),
// et une simple page HTML les affiche en GET — consultable directement dans un
// navigateur, ou récupérable via un fetch externe. Aucune photo ne transite ici, que
// du texte (scores, netteté, durées, texte OCR brut) — voir index.html:diagPush.
//
// Nécessite deux variables d'environnement Vercel : GIST_TOKEN (PAT GitHub, scope
// "gist") et GIST_ID (id d'un gist privé déjà créé, vide au départ).

const FILENAME = 'pokescan-diag.log';
const MAX_LINES = 500;

export default async function handler(req, res) {
  const TOKEN = process.env.GIST_TOKEN;
  const GIST_ID = process.env.GIST_ID;
  if (!TOKEN || !GIST_ID) {
    res.status(500).json({ error: 'GIST_TOKEN / GIST_ID non configurés côté serveur' });
    return;
  }

  const ghHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pokescan-log-relay'
  };

  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = { raw: body }; }
      }
      const entry = { at: new Date().toISOString(), ...body };

      const getRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: ghHeaders });
      if (!getRes.ok) { res.status(502).json({ error: 'lecture gist échouée', status: getRes.status }); return; }
      const gist = await getRes.json();
      const prev = (gist.files && gist.files[FILENAME] && gist.files[FILENAME].content) || '';
      const lines = (prev ? prev.split('\n') : []).concat(JSON.stringify(entry));
      const trimmed = lines.slice(-MAX_LINES).join('\n');

      const patchRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [FILENAME]: { content: trimmed } } })
      });
      if (!patchRes.ok) { res.status(502).json({ error: 'écriture gist échouée', status: patchRes.status }); return; }

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET') {
      const getRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: ghHeaders });
      if (!getRes.ok) { res.status(502).json({ error: 'lecture gist échouée', status: getRes.status }); return; }
      const gist = await getRes.json();
      const content = (gist.files && gist.files[FILENAME] && gist.files[FILENAME].content) || '';
      const entries = content
        ? content.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } })
        : [];

      const format = (req.query && req.query.format) || 'html';
      if (format === 'json') {
        res.status(200).json({ count: entries.length, entries });
        return;
      }
      if (format === 'clear') {
        // Vide le gist — pratique entre deux sessions de test pour repartir propre.
        await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          method: 'PATCH',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: { [FILENAME]: { content: '' } } })
        });
        res.status(200).json({ ok: true, cleared: true });
        return;
      }

      const rows = entries.slice().reverse().map(e => {
        const { at, device, k, t, ...rest } = e;
        return `<tr><td>${esc(at || '')}</td><td>${esc(device || '')}</td><td>${esc(k || '')}</td>` +
               `<td><pre>${esc(JSON.stringify(rest))}</pre></td></tr>`;
      }).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!doctype html><meta charset="utf-8">
<title>PokéScan — logs</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:16px;margin:0}
  h2{font-size:16px;margin:0 0 12px}
  table{width:100%;border-collapse:collapse}
  td{border-bottom:1px solid #333;padding:6px 8px;vertical-align:top;font-size:12px}
  td:first-child{white-space:nowrap;color:#9ab}
  pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:11.5px}
  a{color:#7fb2ef}
</style>
<h2>PokéScan — ${entries.length} observation(s) <a href="?format=json">json</a> · <a href="?format=clear" onclick="return confirm('Vider les logs ?')">vider</a></h2>
<table>${rows}</table>`);
      return;
    }

    res.status(405).json({ error: 'méthode non supportée' });
  } catch (err) {
    res.status(500).json({ error: 'exception serveur', message: err.message });
  }
}

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
