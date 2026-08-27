# PokéScan → eBay Lister

Outil web pour scanner en masse une collection de cartes Pokémon, les identifier
automatiquement et préparer un export CSV pour une mise en vente groupée sur eBay.

Tout tourne **côté navigateur** : aucun serveur, aucune donnée envoyée ailleurs que
vers les API publiques d'identification.

## Utilisation

Ouvrir `index.html` — soit directement depuis le disque, soit via l'URL de déploiement.

⚠️ **La caméra en direct exige HTTPS.** Elle ne fonctionne pas en `file://` : il faut
passer par l'URL hébergée (Vercel, GitHub Pages…) ou `http://localhost`.

## Fonctionnement de l'identification

1. **Détection de la carte** dans la photo (profils d'activité par ligne/colonne), pour
   que le recadrage soit exprimé en % de la *carte* et non de la photo — invariant au
   zoom et au cadrage.
2. **OCR via PaddleOCR (PP-OCRv6)** exécuté en WebAssembly, sur deux passes : le bas de
   carte (meilleure résolution effective sur le numéro) et la pleine image (filet de
   sécurité si la détection de bords se trompe). Modèles ~6 Mo, téléchargés et mis en
   cache au premier scan.
3. **Extraction du numéro** `XXX/XXX` avec normalisation des sosies de chiffres
   (`I`→1, `o`→0, `s`→5…), très fréquents sur cette police italique.
4. **Résolution via [TCGdex](https://tcgdex.dev)** (gratuit, sans clé, cartes en
   français, prix Cardmarket en €) :
   - le dénominateur identifie le set, le numérateur la carte ;
   - le **nom lu par l'OCR sert de garde-fou** : sans confirmation du nom, la
     proposition n'est jamais présentée comme certaine ;
   - repli par recherche du nom + empreinte perceptuelle (dHash) quand le numéro est
     illisible.

Chaque carte de la file est marquée ✅ identifiée · 🤔 à vérifier · ❌ illisible.

## Onglet Sets

Parcours du catalogue complet, série par série (façon pokecardex). Chaque set affiche une
pastille verte quand sa liste de cartes est déjà en cache local — pratique pour vérifier
d'un coup d'œil ce qui est prêt pour une identification sans réseau. Ouvrir un set montre
toutes ses cartes **et** met sa liste en cache au passage : naviguer ici accélère
réellement les scans suivants.

Toucher une carte l'ouvre en grand : zoom jusqu'à 400 % (pincement, molette ou boutons)
et **inclinaison suivie à l'accéléromètre** — bouger le téléphone fait pivoter la carte
en 3D. Sur ordinateur, l'effet suit la souris. Le bouton « 📱 Parallaxe » désactive le
suivi si besoin.

Les cartes réellement brillantes (ex, full art, illustration rare, secrètes…) reçoivent en
plus un **effet holographique** : nappe prismatique, paillettes et liseré de tranche qui se
déplacent à des vitesses différentes selon l'angle — ce décalage entre couches donne la
sensation de relief. Les cartes communes restent mates, comme dans la réalité. Bouton
« ✨ Holo » pour couper l'effet (préférence conservée).

**Relief (expérimental)** — bouton « 🧊 Relief ». Le Pokémon est découpé du décor par un
modèle de segmentation tournant dans le navigateur, puis déplacé plus vite que l'arrière-plan
quand tu inclines : ça donne une vraie profondeur, là où l'holo ne fait que glisser sur une
image plate.

Le premier calcul d'une carte prend **~4 s sur ordinateur** (modèle U²-Netp, 4,7 Mo). Il est
fait dans un worker et ne bloque jamais : la carte s'affiche tout de suite, avec déjà l'effet
de diorama, et passe en relief complet quand c'est prêt. Le masque est ensuite **mis en
cache** — la même carte se rouvre en ~70 ms.

⚠️ La découpe reste inégale selon les illustrations (le modèle est entraîné sur des photos,
pas sur du dessin) : d'où l'interrupteur.

## Notes techniques

- L'OCR travaille sur le **fichier d'origine**, jamais sur la version compressée : le
  ré-encodage JPEG efface les petits chiffres (mesuré : `198/165` lu `98/63`, menant à
  une carte totalement fausse). La version compressée ne sert qu'au stockage et à
  l'affichage.
- Aucune clé API n'est nécessaire.
- Prix indicatifs : Cardmarket (€) en priorité, TCGPlayer ($) en repli.
- **Cache local (IndexedDB)** : tout ce qui vient de TCGdex (listes de cartes par set,
  fiches détaillées, hashs visuels) est mis en cache dans IndexedDB. Un set ou une carte
  déjà rencontrés ne redéclenchent plus aucun appel réseau — utile pour les doublons
  (très fréquents dans une collection) et pour rescanner un set déjà vu. Onglet
  Réglages → « Base de cartes hors-ligne » : bouton pour précharger la liste de tous
  les sets d'un coup plutôt que de les découvrir au fil des scans. Les fiches
  détaillées (prix, rareté) restent chargées à la demande et sont réactualisées après
  14 jours (le prix bouge, l'identité de la carte non).

## Banc d'essai (`bench.html`)

Page de test séparée qui mesure le taux de lecture du numéro sur un échantillon aléatoire
du catalogue. La vérité terrain est gratuite (`localId` + `cardCount.official`), donc la
mesure est objective sur des centaines de cartes sans annotation manuelle. Plusieurs
fenêtres de recadrage sont comparées **sur la même image**, et celle qui mène est
réévaluée périodiquement sur l'ensemble accumulé.

⚠️ Il teste des **illustrations officielles**, pas des photos : il valide la géométrie du
recadrage à travers les époques de cartes, mais ne dit rien de la robustesse au flou ou
aux reflets. Une dégradation synthétique optionnelle s'en approche sans la remplacer.

## Limites connues

- L'identification n'est pas garantie : elle propose, l'utilisateur confirme.
- Les photos peu nettes ou trop éloignées peuvent ne pas livrer de numéro lisible ;
  dans ce cas seul le nom est exploité et le résultat est marqué « à vérifier ».
- L'envoi vers eBay n'est pas automatique : passage par l'import CSV natif du Seller Hub.
