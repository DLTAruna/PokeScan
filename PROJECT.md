# PokéScan → eBay Lister — dossier projet

Contexte complet pour reprendre le développement. Décrit l'objectif, l'état réel du
code, les décisions techniques et *pourquoi* elles ont été prises (plusieurs approches
ont été essayées puis abandonnées sur mesure — c'est documenté pour éviter de les
refaire).

## 1. Objectif

Lister **1000+ cartes Pokémon** sur eBay. L'outil doit permettre de scanner vite
(caméra en rafale ou import de photos en masse), identifier chaque carte
automatiquement, préparer une fiche de vente (titre, description, prix, état) et
exporter le tout pour une mise en ligne groupée — sans accès API développeur eBay.

Contrainte structurante : le volume. L'identification manuelle carte par carte est le
goulot d'étranglement que tout le reste cherche à supprimer.

## 2. État actuel

Application **HTML/JS/CSS en fichier unique**, sans étape de build : `index.html`.

### 2.1 Stack
- Vanilla JS, aucun framework, aucun bundler.
- Dépendances CDN :
  - `jszip@3.10.1` — export des photos en `.zip` ;
  - `ppu-paddle-ocr@6.4.1` + `onnxruntime-web@1.26.0` + `ppu-ocv@3.3.0` — OCR
    PaddleOCR (PP-OCRv6) en WebAssembly, chargés en modules ES via un `importmap`.
- Aucun backend, aucune clé API. Tout tourne dans le navigateur.
- Données cartes : **TCGdex** (`https://api.tcgdex.net/v2`) — gratuit, sans clé,
  cartes en français, prix Cardmarket (€) et TCGPlayer ($).

### 2.2 Hébergement
Déployé sur Vercel depuis GitHub (`DLTAruna/PokeScan`), redéploiement automatique à
chaque push sur `main`. **L'hébergement HTTPS est nécessaire** : `getUserMedia`
(caméra en direct) ne fonctionne pas en `file://`.

### 2.3 Fonctionnalités
- **Capture** : caméra en direct, import en masse, photo unique de secours. Les photos
  sont compressées (max 900px, JPEG 0.75) pour le stockage — mais **jamais pour l'OCR**
  (voir §4.1).
- **File d'attente** (`pendingQueue`) analysée en arrière-plan, chaque entrée marquée
  ✅ identifiée · 🤔 à vérifier · ❌ illisible, avec aperçu en vignettes cliquables.
- **Identification automatique** (voir §3).
- **Lot** (`batch`) : tableau éditable (SKU, titre, état, prix, devise, quantité, URL image).
- **Export** : CSV prêt pour eBay, ZIP des photos, sauvegarde/reprise en `.json`.
- **Réglages** : devise, % du prix marché appliqué, catégorie eBay, templates de
  titre/description, zone OCR, table des sets.

### 2.4 Modèle de données
```js
// entrée de la file d'attente
{
  id,
  photo,        // dataURL JPEG compressé — stockage et affichage
  sourceBlob,   // image d'origine, uniquement le temps de l'analyse puis libérée
  _analysis: { status, card, note, number, denominator, rawText, nameCandidates, ... }
}

// entrée du lot, après identification
{
  id, photo, cardName, setName, number, rarity,
  condition, price, priceCurrency, qty, title, description, sku,
  imageUrl, categoryId
}
```

## 3. Chaîne d'identification

1. **Détection de la carte dans la photo** (`detectCardBounds`) : profils d'activité
   (gradient local) par ligne et par colonne, en tolérant les zones uniformes internes.
   Donne la boîte englobante de la carte.
2. **Recadrage exprimé en % de la CARTE**, jamais de la photo (`cropBottomBandForOcr`) :
   une carte a un format physique fixe, donc la position du numéro relative à ses
   propres bords est invariante au zoom et au cadrage.
3. **OCR PaddleOCR**, deux passes complémentaires : le bas de carte (meilleure
   résolution effective sur le numéro) et la pleine image (filet de sécurité quand la
   détection de bords se trompe).
4. **Extraction du numéro** `XXX/XXX` (`extractNumberCandidates`) avec normalisation des
   sosies de chiffres (`I`→1, `o`→0, `s`→5…), très fréquents sur cette police italique.
5. **Résolution** (`resolveCardBestEffort`), du plus fiable au plus tolérant :
   - dénominateur → set, numérateur → carte, **avec confirmation par le nom lu** ;
   - sans confirmation du nom : proposition acceptée mais **jamais présentée comme
     certaine** ;
   - **repli par nom** (`resolveCardByName`) : recherche TCGdex sur le nom lu, croisé
     avec le numérateur ; à défaut, départage des impressions par empreinte
     perceptuelle dHash ;
   - repli visuel dHash sur les sets candidats.

Le nom lu sert de garde-fou partout : c'est le texte le plus fiablement reconnu.

## 3bis. Caméra en direct : détection + redressement + lecture

La capture automatique en caméra live ne réutilise pas la chaîne ci-dessus telle quelle :
pas de cadre fixe à aligner à la main, la carte est détectée dans l'image, redressée par
perspective, puis lue.

1. **Détection** (`worker: 'detect'`) : un modèle entraîné (`scanic`, détecteur
   `DocCornerNet`/SimCC via ONNX — [github.com/marquaye/scanic](https://github.com/marquaye/scanic),
   licence MIT) localise les 4 coins de la carte dans l'image caméra brute et renvoie un
   score de confiance. Tourne dans le Web Worker (mode `'detect'` uniquement — le mode
   `'extract'` de scanic appelle `document.createElement` et plante en Worker), à chaque
   tick (~350 ms), sans jamais lire de texte.
2. **Redressement par perspective** (`extractDocument`, fil principal) : à partir des 4
   coins, seulement quand le score dépasse `MIN_SCORE` — rare comparé à la détection,
   donc acceptable hors du Worker (~20-60 ms mesurés).
3. **Filtre de forme** : le ratio hauteur/largeur de la carte redressée est comparé à
   `CARD_RATIO` (88/63) avec 25 % de tolérance — rejette les faux positifs (autres objets
   rectangulaires) sans dépendre du score du détecteur seul.
4. **Lecture** (`worker: 'read'`) : bande élargie (78 % largeur × 22 % hauteur, centrée,
   marge de 1,5 % en bas) découpée dans la carte redressée, test de netteté (variance du
   laplacien), puis PaddleOCR — identique à la chaîne §3 à partir de cette étape.

Remplace deux approches abandonnées, documentées dans `index.html` pour ne pas les
retenter : la détection de contour maison en JS (instable sur appareil réel — formes
aberrantes ou cadre calé sur l'écran entier) et, avant elle, OpenCV.js (trop lourd,
chargement qui n'aboutissait pas sur mobile). Le point commun des deux échecs : une
géométrie devinée par heuristique plutôt qu'apprise.

## 4. Décisions techniques et pièges (mesurés, pas supposés)

### 4.1 Ne jamais faire d'OCR sur l'image compressée
Le ré-encodage JPEG 0.75 détruit les petits caractères. Mesuré sur une carte réelle :
`198/165` devenait `98/63` après compression, ce qui menait à identifier un Salamèche
d'Expedition à la place d'un Florizarre-ex. L'analyse travaille donc sur `sourceBlob`
(fichier d'origine), la version compressée ne servant qu'au stockage et à l'affichage.

### 4.2 PaddleOCR et non Tesseract
Comparés sur les mêmes photos réelles : **Tesseract 0/5**, y compris sur un crop
parfaitement isolé et net — la police italique du bandeau lui est illisible. PaddleOCR
lit ces mêmes numéros exactement, et récupère en prime le nom de la carte. Testé aussi
sans succès côté Tesseract : les 6 modes de segmentation, la binarisation d'Otsu, le
seuillage adaptatif local, l'isolation en deux passes, le modèle `eng_best`.

### 4.3 Ne jamais afficher une identification incertaine comme certaine
Un numéro mal lu tombe très facilement sur une carte réelle mais fausse. Sans
confirmation par le nom, le statut retombe systématiquement sur 🤔 « à vérifier ».

### 4.4 Le code lettré du set (« MEW ») n'est pas fiable à l'OCR
C'était l'approche initiale. La police du badge est trop stylisée. Le **dénominateur du
numéro** (`165`) identifie le set bien plus sûrement, via `cardCount.official`.

### 4.5 Correspondances TCGdex
`set.abbreviation.official` = code imprimé (`MEW` pour le set « 151 »).
`card.localId` = numéro de collection. Carte unique :
`/v2/fr/cards/{setId}-{localId}` (ex. `sv03.5-183`).

## 5. Résultats mesurés

Sur 8 photos réelles, via le parcours applicatif complet : **7/8 identifiées
exactement** (nom + set), 2 à 3 s par carte. Le cas restant obtient le bon nom mais la
mauvaise impression, correctement signalé 🤔 — photo trop peu définie pour livrer un
numéro lisible.

## 6. Pistes d'amélioration

1. ~~Cadre de visée et capture automatique en caméra live~~ — fait, voir §3bis
   (détection par modèle entraîné + redressement, plus fiable qu'un cadre fixe aligné à
   la main).
2. ~~Analyse en Web Worker~~ — fait (OCR et détection de carte tous deux hors fil
   principal).
3. Modèles PaddleOCR « server » (plus lourds, plus précis) en option.
4. Vote sur plusieurs fenêtres de recadrage.
5. Pricing : Cardmarket est déjà exploité en priorité ; affiner la conversion et les
   variantes (holo, reverse, 1re édition).
6. Seuils du détecteur (`MIN_SCORE`, tolérance du filtre de forme) à ajuster une fois des
   diagnostics réels disponibles — posés par prudence, pas mesurés sur appareil.

## 7. Risques

- **TCGdex** est un projet communautaire, sans SLA. Un `fetchWithRetry` avec backoff est
  en place. Historique : `api.pokemontcg.io` a été abandonné (instable, ~40-50%
  d'erreurs 5xx constatées, et migration vers Scrydex payant).
- **Volume mémoire** : les originaux sont libérés dès l'analyse faite ; ne pas les
  conserver au-delà sous peine d'explosion sur 1000+ cartes.
- **eBay** : pas d'envoi automatique, passage par l'import CSV natif du Seller Hub.

## 8. Fichiers

- `index.html` — l'application complète.
- `README.md` — documentation d'usage.
- `PROJECT.md` — ce document.

## 9. Références

- [TCGdex — docs REST API](https://tcgdex.dev/rest)
- [ppu-paddle-ocr (SDK PaddleOCR JS)](https://www.npmjs.com/package/ppu-paddle-ocr)
- [Symboles et numéros de set Pokémon (ChaseDex)](https://chasedex.com/guides/sets-symbols-and-abbreviations/)
- [eBay — condition descriptor IDs pour trading cards](https://developer.ebay.com/api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html)
- [eBay — bulk upload via Seller Hub Reports](https://www.img.vision/handbook/ebay/bulk/seller-hub-reports/)
