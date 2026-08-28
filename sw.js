// Service worker de PokéScan.
//
// Objectif volontairement modeste : rendre l'application lançable et utilisable hors ligne,
// sans jamais servir une version périmée du code. Un service worker mal réglé transforme
// une correction en bug permanent — l'ancienne version reste servie et l'utilisateur n'a
// aucun moyen d'en sortir. Toute la stratégie ci-dessous découle de ce risque.

const VERSION = 'pokescan-v1';
const COQUILLE = [
  './',
  './index.html',
  './manifest.json',
  './icone-192.png',
  './icone-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(COQUILLE))
      // skipWaiting : la nouvelle version prend la main sans attendre la fermeture de tous
      // les onglets. Sur une application installée que l'utilisateur ne ferme jamais
      // vraiment, attendre reviendrait à ne jamais mettre à jour.
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // un fichier manquant ne doit pas bloquer l'installation
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Les appels d'API ne sont JAMAIS interceptés : les cotes changent, et l'application
  // gère déjà son propre cache dans IndexedDB, avec ses propres règles de fraîcheur.
  // Une couche de cache supplémentaire ici ne ferait que les contredire.
  if (url.hostname.endsWith('tcgdex.net') || url.pathname.startsWith('/api/')) return;

  const memeOrigine = url.origin === self.location.origin;

  if (memeOrigine) {
    // Réseau d'abord pour le code de l'application : une correction poussée doit arriver
    // dès la prochaine ouverture connectée. Le cache ne sert que de filet hors ligne.
    e.respondWith(
      fetch(req)
        .then((rep) => {
          if (rep && rep.ok) {
            const copie = rep.clone();
            caches.open(VERSION).then((c) => c.put(req, copie));
          }
          return rep;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Ressources externes (modèles ONNX, bibliothèques CDN) : cache d'abord. Elles sont
  // versionnées dans leur URL et pèsent plusieurs mégaoctets — les retélécharger à chaque
  // lancement coûterait du temps et des données mobiles pour un contenu identique.
  e.respondWith(
    caches.match(req).then((cachee) => cachee || fetch(req).then((rep) => {
      if (rep && (rep.ok || rep.type === 'opaque')) {
        const copie = rep.clone();
        caches.open(VERSION).then((c) => c.put(req, copie));
      }
      return rep;
    }))
  );
});

// Permet à la page de forcer la bascule après une mise à jour détectée, sans attendre un
// second rechargement.
self.addEventListener('message', (e) => {
  if (e.data === 'basculer') self.skipWaiting();
});
