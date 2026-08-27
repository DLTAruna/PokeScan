// Petit serveur local pour collecter des photos de cartes depuis le téléphone.
//
// Pourquoi ce détour plutôt qu'une page hébergée : le banc a besoin de photos à la VRAIE
// résolution du capteur (mesuré : ~1150 px sur la carte contre ~560 px en simulation, la
// source TCGdex ne faisant que 600 px de large). Les photos doivent donc venir de
// l'appareil réel — et le plus simple pour les récupérer est de les écrire directement
// sur le disque du PC, sans service tiers ni transfert manuel.
//
// Contrainte contournée : `getUserMedia` exige un contexte sécurisé, donc une page servie
// en http://192.168.x.x n'aurait AUCUN accès caméra. La page utilise donc
// `<input capture>`, qui délègue à l'appareil photo natif — pas de HTTPS nécessaire, et
// une meilleure définition que l'aperçu vidéo par-dessus le marché.
//
// Aucune dépendance : modules Node natifs uniquement, pour que `node capture-server.js`
// suffise.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8899;
const DOSSIER = path.join(__dirname, 'photos-test');

if (!fs.existsSync(DOSSIER)) fs.mkdirSync(DOSSIER, { recursive: true });

// Adresses IPv4 locales, pour afficher au démarrage l'URL à ouvrir sur le téléphone —
// sans ça il faudrait aller la chercher à la main dans les réglages réseau.
function adressesLocales() {
  const out = [];
  for (const cartes of Object.values(os.networkInterfaces())) {
    for (const c of cartes || []) {
      if (c.family === 'IPv4' && !c.internal) out.push(c.address);
    }
  }
  return out;
}

// Nom de fichier au format de l'app (PKMN-{set}-{numero}-{horodatage}.jpg) : le banc sait
// déjà le lire, la vérité terrain est donc disponible sans aucun étiquetage séparé.
function nomFichier(set, numero) {
  const propre = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '');
  return `PKMN-${propre(set) || 'set'}-${propre(numero) || '0'}-${Date.now().toString().slice(-5)}.jpg`;
}

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/capture.html')) {
    fs.readFile(path.join(__dirname, 'capture.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('capture.html introuvable'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Liste des photos déjà reçues : permet à la page d'afficher un compteur fiable même
  // après un rechargement, plutôt qu'un compte tenu seulement en mémoire du navigateur.
  if (req.method === 'GET' && url.pathname === '/liste') {
    fs.readdir(DOSSIER, (err, fichiers) => {
      const photos = (fichiers || []).filter(f => /\.jpe?g$/i.test(f));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: photos.length, dossier: DOSSIER, photos: photos.slice(-30) }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    const set = url.searchParams.get('set');
    const numero = url.searchParams.get('numero');
    // Corps binaire brut plutôt que multipart : ça évite d'écrire un analyseur multipart
    // à la main (ou d'ajouter une dépendance) pour un besoin aussi simple.
    const morceaux = [];
    let taille = 0;
    req.on('data', (m) => {
      taille += m.length;
      // Garde-fou : une requête anormalement grosse ne doit pas saturer la mémoire.
      if (taille > 25 * 1024 * 1024) { req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', () => {
      const nom = nomFichier(set, numero);
      fs.writeFile(path.join(DOSSIER, nom), Buffer.concat(morceaux), (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erreur: err.message }));
          return;
        }
        console.log(`📷 ${nom}  (${Math.round(taille / 1024)} Ko)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fichier: nom, ko: Math.round(taille / 1024) }));
      });
    });
    return;
  }

  res.writeHead(404); res.end('non trouvé');
});

serveur.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Serveur de capture démarré.');
  console.log('  Photos écrites dans : ' + DOSSIER);
  console.log('');
  console.log('  Ouvre cette adresse SUR TON TÉLÉPHONE (même réseau Wi-Fi) :');
  for (const ip of adressesLocales()) console.log(`     http://${ip}:${PORT}`);
  console.log('');
  console.log('  Ctrl+C pour arrêter.');
  console.log('');
});
