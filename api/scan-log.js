// Relais des résultats du SCANNER DE TEST (`scanner-test.html`).
//
// Même principe que `api/log.js` (qui, lui, relaie les diagnostics de l'app), mais son
// propre fichier dans le même gist privé : les deux flux ne se marchent pas dessus, et le
// cap de 500 lignes de l'un n'évince pas l'autre.
//
// Le scanner POST une entrée par identification confirmée/corrigée :
//   { device, fichier, cardId, predit, attendu, juste, conf, inliers, marge,
//     ocrLance, ms, T:{redress,emb,orb,ocr}, moteur }
// et cette API l'ajoute au gist. GET ?format=json pour tout relire, ?format=clear pour
// repartir propre entre deux sessions.
//
// Réutilise les mêmes variables d'environnement Vercel que log.js : GIST_TOKEN, GIST_ID.

const FILENAME = 'pokescan-scan.log';
const MAX_LINES = 1000;

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
    'User-Agent': 'pokescan-scan-relay'
  };
  const lireGist = () => fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: ghHeaders });
  const ecrireFichier = (content) => fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [FILENAME]: { content } } })
  });

  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { raw: body }; } }
      const at = new Date().toISOString();
      const entries = Array.isArray(body && body.entries)
        ? body.entries.map((e) => ({ at, ...e }))
        : [{ at, ...body }];

      const getRes = await lireGist();
      if (!getRes.ok) { res.status(502).json({ error: 'lecture gist échouée', status: getRes.status, github: await getRes.text() }); return; }
      const gist = await getRes.json();
      const prev = (gist.files && gist.files[FILENAME] && gist.files[FILENAME].content) || '';
      const lines = (prev ? prev.split('\n').filter(Boolean) : []).concat(entries.map((e) => JSON.stringify(e)));
      const patchRes = await ecrireFichier(lines.slice(-MAX_LINES).join('\n'));
      if (!patchRes.ok) { res.status(502).json({ error: 'écriture gist échouée', status: patchRes.status, github: await patchRes.text() }); return; }

      res.status(200).json({ ok: true, recues: entries.length });
      return;
    }

    if (req.method === 'GET') {
      const getRes = await lireGist();
      if (!getRes.ok) { res.status(502).json({ error: 'lecture gist échouée', status: getRes.status, github: await getRes.text() }); return; }
      const gist = await getRes.json();
      const content = (gist.files && gist.files[FILENAME] && gist.files[FILENAME].content) || '';
      const entries = content
        ? content.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } })
        : [];

      const format = (req.query && req.query.format) || 'json';
      if (format === 'clear') {
        const clearRes = await ecrireFichier(JSON.stringify({ at: new Date().toISOString(), k: 'clear' }));
        if (!clearRes.ok) { res.status(502).json({ error: 'vidage gist échoué', status: clearRes.status, github: await clearRes.text() }); return; }
        res.status(200).json({ ok: true, cleared: true });
        return;
      }
      // Résumé rapide + liste, en JSON.
      const scans = entries.filter(e => e.k !== 'clear' && e.fichier);
      const justes = scans.filter(e => e.juste === true).length;
      const msVals = scans.map(e => e.ms).filter(v => typeof v === 'number').sort((a, b) => a - b);
      res.status(200).json({
        count: entries.length,
        resume: {
          scans: scans.length,
          justes,
          taux: scans.length ? Math.round(1000 * justes / scans.length) / 10 : null,
          ocrLance: scans.filter(e => e.ocrLance).length,
          msMedian: msVals.length ? msVals[Math.floor(msVals.length / 2)] : null,
          parConf: scans.reduce((a, e) => (a[e.conf] = (a[e.conf] || 0) + 1, a), {}),
        },
        entries
      });
      return;
    }

    res.status(405).json({ error: 'méthode non supportée' });
  } catch (err) {
    res.status(500).json({ error: 'exception serveur', message: err.message });
  }
}
