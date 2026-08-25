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

Deux Workers séparés, pas un seul — et deux boucles indépendantes côté fil principal
(`detectLoop` / `attemptRead`), pour la même raison : sans isolation multi-thread WASM
(COOP/COEP non activés sur ce déploiement), un appel OCR (jusqu'à ~2 s) occupe le fil JS
du worker qui le reçoit, et un appel de détection arrivé pendant ce temps resterait
simplement en attente derrière lui — le cadre de visée se figeait pendant toute la durée
d'une tentative de lecture. Mesuré après séparation : 4 appels de détection consécutifs
(88-194 ms chacun) aboutissent bien pendant qu'un appel OCR (1,36 s) tourne encore dans
l'autre worker.

1. **Détection** (worker dédié, `getDetectWorker`/`detectWorkerCall`) : un modèle
   entraîné (`scanic`, détecteur `DocCornerNet`/SimCC via ONNX —
   [github.com/marquaye/scanic](https://github.com/marquaye/scanic), licence MIT)
   localise les 4 coins de la carte dans l'image caméra brute et renvoie un score de
   confiance. Mode `'detect'` uniquement — le mode `'extract'` de scanic appelle
   `document.createElement` et plante en Worker. `detectLoop()` l'appelle en continu
   (auto-replanifiée, pas un intervalle fixe), sans jamais lire de texte — c'est ce qui la
   garde rapide et permet un cadre quasi temps réel.
   L'image lui est envoyée **réduite à `DETECT_LONG_EDGE` (512 px de grand côté)**, jamais
   en pleine résolution caméra : le modèle redimensionne son entrée en interne de toute
   façon, donc envoyer du 960×1280 faisait payer deux fois (voir §4.6).
2. **Redressement par perspective** (`extractDocument`, fil principal, dans
   `attemptRead()`) : à partir des 4 coins, seulement quand le score dépasse `MIN_SCORE`
   — et sans bloquer `detectLoop`, qui continue en parallèle (~20-60 ms mesurés).
3. **Filtre de forme, dans les deux sens** : le ratio hauteur/largeur de la carte
   redressée est comparé à `CARD_RATIO` (88/63) ET à son inverse (63/88), tolérance 25 %
   — scanic étiquette les coins par position dans l'image, pas selon l'orientation
   imprimée, donc une carte tenue légèrement tournée peut ressortir "en paysage" sans être
   un faux positif (constaté sur diagnostic réel). Si c'est le cas, l'image est pivotée à
   90° avant lecture (sens arbitraire, faute d'indice sur l'orientation réelle).
4. **Lecture** (worker OCR existant, `workerCall('read', ...)`) : test de netteté sur la
   carte entière (voir §4.8, pourquoi pas sur la bande) puis bande **serrée** en bas à
   gauche (0-45 % × 84-99 %, ×2), avec repli sur une bande large (0.11×0.685, 78 %×30 %)
   si aucun numéro n'y est trouvé — voir §4.8 pour la géométrie et les mesures, §4.9 pour
   `{noCache:true}` (obligatoire, pas une option). Déclenchée par `detectLoop` mais jamais
   attendue par elle (fire-and-forget, garde `readInFlight` + `MIN_READ_INTERVAL_MS` pour
   éviter les tentatives redondantes).

Remplace deux approches abandonnées, documentées dans `index.html` pour ne pas les
retenter : la détection de contour maison en JS (instable sur appareil réel — formes
aberrantes ou cadre calé sur l'écran entier) et, avant elle, OpenCV.js (trop lourd,
chargement qui n'aboutissait pas sur mobile). Le point commun des deux échecs : une
géométrie devinée par heuristique plutôt qu'apprise.

5. **Panneau de résultat live** (`resolveLiveResult`, sous la caméra) : dès qu'un
   numéro est lu (étape 4), affiche immédiatement la miniature + « 🔎 recherche… »
   (`showLiveResultPending`), puis lance la MÊME chaîne de résolution que l'onglet
   Identifier (`resolveCardBestEffort` — set par dénominateur/code, confirmation par
   nom, repli visuel) et complète nom/set/prix dès qu'elle répond
   (`showLiveResultDone`), avec un badge ✅ (confiance haute, nom confirmé) ou 🤔
   (proposition non confirmée) — jamais un résultat présenté comme sûr par défaut,
   cohérent avec le risque de lecture erronée déjà documenté (§4.9, §4.11).
   Un jeton (`liveResultSeq`) écarte les réponses tardives si l'utilisateur change de
   carte avant que la résolution précédente ait fini de répondre. Le résultat est en
   plus attaché à l'item de la file (`item._analysis`, même forme que
   `analyzeQueueItem`) : `processQueueAnalysis` ne referrera donc jamais cette carte
   une fois la caméra arrêtée — le travail déjà fait en direct n'est pas jeté.

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

### 4.6 Ne pas envoyer la pleine résolution au détecteur
Le modèle redimensionne son entrée en interne : lui passer l'image caméra brute fait
payer deux fois — une conversion `bitmap`→`ImageData` bien plus lourde côté worker, puis
un redimensionnement interne plus long. Décomposition mesurée sur la même scène :

| Étape (par détection)        | 960×1280 | 384×512 |
|------------------------------|---------:|--------:|
| Conversion `bitmap`→`ImageData` | 44,8 ms | 14,9 ms |
| Préparation du modèle           | 25,4 ms |  8,3 ms |
| Inférence                       | 34,1 ms | 28,5 ms |
| **Total**                       | **~104 ms** | **~52 ms** |

Les coins renvoyés sont **identiques à la 3ᵉ décimale** de 1280 px à 320 px de grand côté
(écart max mesuré : 0,001, soit moins d'1 px sur 960). D'où `DETECT_LONG_EDGE = 512`, qui
garde une marge confortable au-dessus du seuil où la précision bougerait. Le
redimensionnement est fait par `createImageBitmap({resizeWidth, resizeHeight})` (chemin
optimisé du navigateur) et non dans le worker, pour que le bitmap transféré soit déjà
petit. Les coins revenant en fractions 0-1, tout l'aval y est indifférent — et le
redressement comme l'OCR continuent de travailler sur l'image **pleine résolution**.

### 4.7 Pourquoi l'app native concurrente est plus rapide (et ce que ça n'apporte pas)
Analyse du paquet `com.sarafan.pokemon` (noms de classes et bibliothèques natives
uniquement) : leur fluidité vient de `libLiteRt.so` + **`libLiteRtClGlAccelerator.so`** —
l'inférence tourne sur le **GPU** via OpenCL/OpenGL, en natif, avec CameraX en amont. Côté
web on est sur ONNX/**WASM CPU** : c'est là qu'est le facteur d'échelle, et aucune
transposition de leur code applicatif ne le comblerait. Leur chaîne d'identification
diffère aussi (embedding visuel + recherche vectorielle côté serveur, `EmbeddingHelper` /
`CosineSimilarity` / `VectorSearchRequest`) plutôt qu'une lecture du numéro.
Piste web qui, elle, attaquerait le bon problème : un runtime ONNX avec **exécution
WebGPU**. `scanic` n'expose pas `executionProviders` (il embarque son propre build WASM
minimal), donc cela demanderait de piloter `onnxruntime-web` directement avec le modèle.

### 4.8 La bande de lecture doit être ancrée à gauche, pas centrée
Une carte Pokémon place le numéro en bas à GAUCHE ; une bande centrée démarre trop loin du
bord et rogne le premier chiffre. Diagnostic réel : `007/165` lu `07/16s`, `001/165` lu
`o1/16s`. Confirmé isolément : la même bande centrée (78 %×30 %) sur une mise en page
réaliste (attaque + barre Faiblesse/Résistance/Retraite + texte d'ambiance + numéro) lit
`165` — le `037/` n'atteint même pas `extractNumberCandidates`, faute de `/` détecté avec
assez de chiffres des deux côtés dans le texte OCR retourné.

Bande resserrée : ancrée à gauche (`fx=0`), zone 0-45 % de largeur × 84-99 % de hauteur
(le numéro occupe ~5-32 % × ~93-98 %, marge ~2×), agrandie ×2 avant OCR — PaddleOCR
normalise ses lignes autour de 32-48 px de haut, or le numéro n'en fait qu'une vingtaine à
l'échelle native de la carte. Mesuré sur la même mise en page réaliste : 335 ms contre
810 ms pour l'ancienne bande (-59 %), 2 lignes détectées contre 5, et le numéro complet
correctement lu là où l'ancienne bande le tronquait.

Repli sur une bande large si la bande serrée échoue : couvre les mises en page où le
numéro sortirait de la zone serrée. Le champ `via` du diagnostic (`serree` / `large`)
dit lequel a servi.

**Mise à jour, sur relevé réel (41 observations, deux appareils)** : la première version
du repli (0.11×0.685, 78 % de largeur — quasiment toute la carte) n'a **trouvé un numéro
zéro fois**, mais a coûté de 815 ms à **8,7 s** à chaque déclenchement, attrapant du texte
d'attaque au passage (« Coud'Krâne », « Morsure »). Resserré à `crop(0, 0.62, 0.48, 0.37,
1)` — même ancrage à gauche que la bande serrée (le numéro n'est jamais ailleurs), seule
la hauteur reste plus tolérante (0.62-0.99 contre 0.84-0.99). Testé isolément : un numéro
placé hors de la bande serrée mais dans la moitié gauche est toujours rattrapé (810 ms),
et un échec total résout en <500 ms au lieu de plusieurs secondes.

Le moteur PaddleOCR n'exposant pas d'annulation, un `Promise.race` avec un délai de
1200 ms borne l'ATTENTE de l'appelant (qui peut redonner la main à la boucle de visée),
pas le calcul lui-même — un appel abandonné continue de tourner en tâche de fond dans le
worker. Utile quand même : mieux vaut ne plus bloquer l'appelant sur un repli qui,
empiriquement, ne trouve jamais rien.

Piège associé : la netteté doit être mesurée sur la **carte entière**, pas sur la bande
serrée. Une bande sans contenu (mise en page atypique, zone sombre et lisse d'une
full-art) donne une variance nulle même sur une image parfaitement nette — l'image était
alors rejetée comme floue et le repli n'avait jamais sa chance. La netteté est une
propriété de la prise de vue, pas du cadrage.

### 4.9 Le cache interne de ppu-paddle-ocr confond des cartes différentes
`ppu-paddle-ocr` met en cache ses résultats par une clé qui ne hache que les **1024
premiers octets** du tampon de pixels (`ImageCache.generateKey`, `core/image-cache.js`)
— environ 256 pixels de la première ligne de l'image. Sur une bande de lecture, cette
ligne est presque toujours du fond uni : deux cartes différentes produisent la même clé,
et le service renvoie le numéro de la précédente **en quelques millisecondes** au lieu de
lire la nouvelle. Reproduit isolément : trois numéros distincts (`111/111`, `222/222`,
`333/333`) envoyés à la suite ont tous renvoyé le premier lu.

C'est le type de bug qui passe totalement inaperçu en test (une seule image à la fois)
et se déclenche uniquement en usage réel (cartes différentes à la chaîne) — sans lui, on
aurait pu réintroduire silencieusement une fausse identification bien après avoir corrigé
celle de §4.1. Tous les appels à `recognize()` passent donc `{noCache:true}` — le cache
n'apporte de toute façon rien ici, deux images caméra n'étant jamais identiques au bit
près.

### 4.10 Redimensionnement précoce du redressement et du transfert vers l'OCR
Deux points chauds symétriques à §4.6 (qui ne concernait que le détecteur) : `attemptRead`
construisait la frame passée à `extractDocument` en pleine résolution capteur (souvent
3000-4000px de large), alors qu'`extractDocument` tourne sur le **fil principal**
(dépendance DOM de scanic, non déplaçable en Worker — voir §3bis) et paie donc son coût
en latence perçue directement. Pire, la sortie redressée pleine résolution était ensuite
transférée telle quelle vers le Worker OCR, qui la redessinait de toute façon sur un canvas
`cardW=600` — le surplus de pixels ne servait qu'à alourdir le `postMessage` et refaire un
redimensionnement déjà inutile.

Corrigé aux deux endroits avec le même levier que §4.6 : `createImageBitmap(source,
{resizeWidth, resizeHeight, resizeQuality:'medium'})` en amont, avant toute copie sur
canvas — `EXTRACT_LONG_EDGE = 1200` pour la frame envoyée à `extractDocument`, et une
marge de 700px (600 + 100) pour le bitmap transféré au Worker OCR. Les coordonnées des
coins (`cornersPx`) sont calculées à partir de la frame déjà redimensionnée, pas de la
résolution native — cohérent avec le fait que les coins renvoyés par le détecteur sont
en fractions 0-1, indifférents à la résolution.

### 4.11 Occlusion par les doigts : un problème d'INTERFACE, pas d'algorithme
Tenir une carte en main recouvre inévitablement une partie des bords. Deux cas distincts :
- **Un coin masqué** (typiquement le bas-gauche, tenu du pouce) est le plus embêtant : il
  coïncide avec la zone de lecture du numéro (§4.8) — double peine potentielle.
- **Un bord partiellement masqué en son milieu** (doigts posés sur le côté) est moins
  risqué qu'il n'y paraît : `Scanic` (`detector:'ml'`) régresse les 4 coins de façon
  holistique à partir de l'image entière (pas un suivi de contour classique type Hough),
  un type de modèle généralement entraîné sur des documents tenus à la main — donc pas
  forcément fragile à ce cas. Pas de certitude sans diagnostic réel : à valider avant
  d'investir dans une reconstruction géométrique du coin manquant.

Correctif appliqué, le plus rentable et sans risque : un rappel visuel permanent dans le
cadre caméra (« ✋ Tiens la carte par le haut, laisse les bords libres ») plutôt qu'une
tentative de compenser algorithmiquement une occlusion qu'on peut éviter à la source.

### 4.12 Relais de diagnostic à distance (`api/log.js`)
Jusqu'ici, un diagnostic réel exigeait que l'utilisateur copie/colle le rapport
(`buildDiagReport`) dans le chat. Ajout d'un canal réseau optionnel pour observer les
résultats directement, sans repasser par un copier/coller :

- Nouvelle fonction serverless Vercel `api/log.js` (zero-config, aucune dépendance npm) :
  POST ajoute une observation à un **Gist GitHub privé** (seul stockage persistant
  disponible sans base de données à provisionner) ; GET affiche les observations en
  HTML lisible (`?format=json` pour un accès programmatique, `?format=clear` pour vider
  entre deux sessions de test). Nécessite deux variables d'environnement Vercel côté
  serveur, jamais exposées au client : `GIST_TOKEN` (PAT GitHub scope `gist`) et
  `GIST_ID` (id d'un gist privé déjà créé).
- Côté client : `diagPush` reste inchangé dans son usage (stockage local + export manuel
  toujours disponibles), mais relaie maintenant chaque observation vers `/api/log` **si**
  la case à cocher « 📡 envoyer en direct (debug) » est cochée — décochée par défaut,
  choix mémorisé dans `localStorage`. C'est un renversement assumé du principe initial
  « rien n'est envoyé nulle part » (§ ENREGISTREUR DE DIAGNOSTIC dans `index.html`) :
  seuls des champs texte (scores, netteté, durées, texte OCR brut) transitent, jamais de
  photo, et seulement quand l'utilisateur l'active explicitement.
- Envoi en best-effort (`fetch(...).catch(()=>{})`), jamais attendu : une panne réseau ne
  doit ni ralentir ni casser le scan en cours.
- **Bug attrapé en testant avant de livrer** : le code de câblage de la case à cocher
  avait été placé, par erreur, avant la déclaration `let diagRemoteEnabled` plus bas dans
  le fichier — une référence anticipée (TDZ) qui levait une `ReferenceError` dès le
  chargement de la page et arrêtait net l'exécution de TOUT le script à partir de ce
  point (donc aussi `diagLog`/`diagPush`, jamais initialisés). Détecté via les logs
  console du navigateur pendant le test local, pas par simple relecture ; corrigé en
  regroupant le câblage de la case avec le reste du bloc diagnostic, après sa
  déclaration.

### 4.13 Le panneau live ne peut jamais atteindre ✅ : la confirmation par le nom exige un texte qu'il n'a pas
Constaté sur un relevé réel après la mise en place du panneau (§3bis point 5) : toutes
les identifications étaient correctes mais aucune n'affichait jamais ✅, uniquement 🤔.

Cause, trouvée dans le code plutôt que devinée : `cardNameAppearsInText` (utilisée par
`resolveCardBestEffort` pour n'accorder une confiance haute que si le nom du Pokémon
confirme le numéro — garde-fou contre un chiffre mal lu qui désignerait quand même une
vraie carte, mais la mauvaise) reçoit le texte OCR **du direct**, qui ne provient que de
la bande du bas (§4.8, lecture du numéro). Le nom est toujours en haut de la carte : ce
texte ne peut structurellement jamais le contenir, donc la confirmation échoue à chaque
fois, même quand l'identification est déjà exacte.

Corrigé sans ralentir l'affichage déjà rapide : `attemptRead` découpe en plus une bande
du haut de la carte redressée (22 % de hauteur, simple crop-resize natif, pas d'OCR à ce
stade) et la transmet à `resolveLiveResult`. Le résultat 🤔 s'affiche immédiatement comme
avant ; SI la confiance n'est pas déjà haute, `confirmLiveResultByName` lance ensuite,
en arrière-plan, une lecture OCR de cette seule bande (`workerCall('ocr', ...)`, sans
relancer de recherche TCGdex) et fait passer le badge à ✅ si le nom confirme — sinon le
résultat reste 🤔, jamais présenté comme plus sûr qu'il ne l'est.

### 4.14 Caméra en plein écran
Demande directe : la caméra et le panneau live prenaient trop peu de place au milieu du
reste de la page. Plutôt que l'API Fullscreen (peu fiable sur Safari iOS pour un élément
quelconque — seule la balise `<video>` y a un vrai support natif, pas un conteneur
arbitraire), un simple overlay CSS (`#cam-fullscreen-area.fs` : `position:fixed;
inset:0`) recouvre toute la page dès `startCamera()`, retiré par `stopCamera()` — plus
fiable cross-navigateur, et suffisant puisque rien n'a besoin de sortir du DOM du
navigateur lui-même.

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
2bis. ~~Panneau de résultat live sous la caméra~~ — fait, voir §3bis point 5.
3. Modèles PaddleOCR « server » (plus lourds, plus précis) en option.
4. Vote sur plusieurs fenêtres de recadrage.
5. Pricing : Cardmarket est déjà exploité en priorité ; affiner la conversion et les
   variantes (holo, reverse, 1re édition).
6. Seuils du détecteur (`MIN_SCORE`, tolérance du filtre de forme) à ajuster une fois des
   diagnostics réels disponibles — posés par prudence, pas mesurés sur appareil.
7. Fusionner les deux tentatives OCR (bande serrée + repli large, §4.8) en un seul appel
   `recognize()` sur une image composite, si le prochain diagnostic confirme un coût fixe
   important par appel — non fait faute de données pour trancher.
8. En-têtes COOP/COEP (`vercel.json`) pour activer `SharedArrayBuffer` → WASM multi-thread
   côté OCR (pas seulement détection) — le plus gros levier restant vu que l'OCR est
   maintenant le vrai goulot, pas encore posé.
9. Whitelist de caractères (chiffres + `/`) côté `ppu-paddle-ocr` si l'API l'expose — à
   vérifier, pourrait réduire l'espace de recherche du décodeur.

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
