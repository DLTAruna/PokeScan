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

**RETIRÉ ENSUITE** : même resserré et borné dans le temps, ce repli n'a JAMAIS trouvé un
numéro sur l'ensemble des relevés réels collectés (plusieurs dizaines d'observations,
plusieurs sessions) — et c'est lui qui faisait qu'une tentative ratée (le cas le plus
fréquent, avant qu'une carte soit parfaitement cadrée) coûtait 1,8-3 s au lieu de
quelques centaines de ms, exactement la source du délai que l'utilisateur ressentait.
Objectif explicite à partir de là : capturer vite sans exiger un cadrage parfait plutôt
que maximiser le taux de récupération d'un repli qui ne rapportait rien. Vérifié : un
échec résout maintenant en ~220 ms au lieu de plusieurs secondes, la lecture normale
(bande serrée) inchangée (~330 ms sur le même test).

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

**Complété ensuite** (retour utilisateur : le panneau live disparaissait sous les
contrôles de diagnostic et la file, poussé hors écran) : en plein écran, la vidéo prend
tout l'espace disponible (`flex:1`, plus de plafond `max-height:60vh`) et le panneau de
résultat reste `flex-shrink:0` juste en dessous — donc TOUJOURS visible, jamais poussé
hors champ. Les contrôles de diagnostic/file d'attente sont masqués en plein écran (pas
supprimés, juste `display:none` le temps du scan) pour laisser toute la place aux deux
éléments qui comptent. Le panneau live s'affiche aussi dès `startCamera()` avec un état
« en attente d'une carte » (`showLiveResultWaiting`), plutôt que de n'apparaître qu'après
la première capture — cohérent avec « toujours affiché ».

### 4.15 Préchauffage des workers dès le chargement de la page
« Préparation de la lecture... » (au clic sur "Démarrer la caméra") pouvait être long :
c'est le téléchargement (~9,5 Mo à eux deux, OCR + détecteur) et l'initialisation ONNX
des deux workers qui s'y cachaient, déclenchés à ce moment précis par
`Promise.all([workerCall('init'), detectWorkerCall('init')])` dans `startAimLoop()`.
Rien n'empêchait de lancer ce chargement bien plus tôt, pendant que l'utilisateur lit
l'écran d'accueil : le même appel est maintenant aussi déclenché une fois, en tâche de
fond, dès le chargement de la page. `startAimLoop()` réappelle exactement le même
`workerCall('init')`/`detectWorkerCall('init')` — chacun mémorise son propre chargement
en interne (`ensure()` dans le worker), donc ce second appel se résout quasi
instantanément si le préchauffage a déjà fini. Vérifié : après quelques secondes sur la
page, un appel `workerCall('init')` direct résout en **0 ms** au lieu du temps de
téléchargement + compilation WASM complet.

### 4.16 Cadre à coins arrondis
Une vraie carte Pokémon a les coins arrondis, pas droits — le cadre de visée traçait un
quadrilatère à angles vifs. `roundedPolyPath()` (technique `arcTo()` standard, rayon
borné à la moitié de chaque arête adjacente pour rester correct même sur un
quadrilatère fin) remplace le tracé droit, pour le masque assombri ET le contour coloré.
Retire au passage les petits traits d'angle qui compensaient visuellement l'absence
d'arrondi — devenus inutiles. Vérifié par inspection de pixels (pas seulement visuelle) :
l'intérieur du cadre reste bien totalement transparent (alpha 0) et l'extérieur
correctement assombri (alpha ~0,38), le découpage `evenodd` n'a pas régressé avec le
changement de tracé.

Sur la fluidité (« 100 fps ») : la boucle (`renderOverlayLoop`, `requestAnimationFrame`)
tournait déjà sans plafond artificiel — un navigateur cale `requestAnimationFrame` sur le
taux de rafraîchissement RÉEL de l'écran (60 Hz le plus souvent, 90/120 Hz sur certains
téléphones) ; il n'existe aucun moyen web standard de forcer un taux fixe au-delà de ce
que l'écran affiche. Rien à changer côté code pour ce point précis — déjà au maximum
possible.

### 4.17 Mise au point caméra dégradée sur certains appareils (constaté : Samsung)
Retour utilisateur : sur son Samsung, la mise au point ne s'engageait même pas via la
page web, rendant la capture live inutilisable, alors qu'une appli caméra native n'a pas
ce problème. `getUserMedia` n'imposait aucune contrainte de mise au point, et la
résolution demandée était plafonnée à 1280×960 — un choix fait pour épargner le pipeline
OCR, mais qui peut aussi pousser le pilote caméra de certains appareils vers un mode
capteur dégradé où l'autofocus ne s'engage plus (une appli native demande toujours le
plein capteur).

Deux corrections, sans regain de coût de traitement (le pipeline downscale déjà tout
très tôt — §4.6, §4.10 — la caméra n'a plus besoin de fournir une petite image) :
- Résolution demandée remontée à 1920×1440.
- `focusMode:'continuous'` demandé dans les contraintes ET reconfirmé après coup via
  `track.applyConstraints()` (uniquement si `getCapabilities()` déclare le supporter —
  certains navigateurs n'honorent ce réglage que via cette seconde voie, pas dans les
  contraintes initiales de `getUserMedia`).

Honnêteté nécessaire, non vérifiable ici (pas d'accès à un vrai appareil Samsung) : le
support de `focusMode` varie selon navigateur/puce, donc ce correctif n'est pas garanti
à 100 %. Les capacités et réglages RÉELS rapportés par l'appareil sont maintenant
poussés au diagnostic (`caméra: focusMode capacités=... réglage=... résolution=...`) —
le prochain relevé dira si le Samsung expose ce réglage ou si c'est une vraie limite
plateforme, sans quoi il n'existe aucune solution côté web.

**Cause réelle identifiée par l'utilisateur ensuite** : le flou venait de l'objectif
sélectionné, pas (seulement) de l'absence de mise au point continue — sur les
téléphones multi-objectifs (Samsung notamment), `facingMode:'environment'` peut ouvrir
l'objectif logique sur le grand-angle (~0.6×) plutôt que le principal (1×). Le
grand-angle a une profondeur de champ/mise au point différente, mal adaptée à une prise
de vue rapprochée d'une carte. Corrigé en ajoutant `zoom:{ideal:1}` aux contraintes
initiales ET en le reconfirmant après coup via `track.applyConstraints({advanced:
[{zoom:1}]})` — même schéma que `focusMode`, appliqué uniquement si `getCapabilities()`
déclare une plage de zoom couvrant 1 (`caps.zoom.min <= 1 && caps.zoom.max >= 1`), pour
ne jamais lever d'exception sur un réglage hors plage. Les capacités de zoom réelles
sont poussées au même message de diagnostic que le focus.

### 4.18 En-têtes COOP/COEP pour le WASM multi-thread — posés puis RETIRÉS (régression constatée)
`vercel.json` ajoutait `Cross-Origin-Opener-Policy: same-origin` et
`Cross-Origin-Embedder-Policy: credentialless` sur toutes les routes — active
`SharedArrayBuffer`/`crossOriginIsolated`, condition nécessaire au WASM multi-thread
d'onnxruntime-web (utilisé en interne par Scanic et ppu-paddle-ocr). `credentialless`
plutôt que `require-corp` pour ne pas casser le chargement des images TCGdex
(serveur externe, aucun contrôle sur ses en-têtes) — vérifié que ça fonctionnait bien
sur le déploiement réel avant de considérer le sujet clos.

Posé avec une réserve explicite : « crée la précondition, ne garantit pas qu'onnxruntime-
web l'exploite réellement — à mesurer, pas à supposer ». Sur le relevé suivant, les
captures réussies (bande serrée, rien d'exotique) sont passées de 577-1625 ms à
**2100-3050 ms** — quasiment le double, sans qu'aucun autre changement du code
n'explique un tel écart sur la durée de l'appel OCR lui-même. Hypothèse la plus
plausible : sur cet appareil, forcer plusieurs threads WASM coûte plus en overhead de
synchronisation qu'il ne fait gagner en parallélisation — un risque réel et connu du
multi-thread sur des appareils à peu de cœurs performants, exactement le genre de
résultat que la mesure devait détecter.

Honnêteté sur la limite de cette conclusion : un seul relevé ne prouve pas la causalité
avec certitude (un échauffement du téléphone après plusieurs tests d'affilée aurait pu
aussi ralentir le CPU, indépendamment de tout code). Mais c'était la variable la plus
plausible, la moins chère à isoler et totalement réversible sans risque — retirée pour
confirmer par un nouveau test avant/après propre. `vercel.json` supprimé du dépôt.

### 4.19 Préchauffage de la table des sets TCGdex
Même logique que le préchauffage des workers (§4.15) appliquée à la table des sets
(`setAbbrMap`/`setDenominatorMap`, utilisée par `resolveCardBestEffort` pour retrouver
le set à partir du numéro) : si le cache local (`localStorage`, 30 jours) est absent ou
expiré, le chargement démarre dès l'ouverture de la page au lieu d'attendre le premier
succès de lecture en direct — sans ce préchauffage, c'est spécifiquement CE premier
résultat qui restait bloqué sur « recherche... » le temps du chargement.

### 4.20 Le délai « Stabilise la carte » venait des redémarrages, pas du seuil lui-même
Retour utilisateur : tenir la carte immobile 1-2 secondes avant capture, frustrant. Le
verrou de stabilité (§ ci-dessus) ne compare pourtant que DEUX détections consécutives —
en théorie quasi instantané. La vraie cause : `prevCorners` était remis à `null` au
moindre passage du score sous `MIN_SCORE` (reflet, main qui repositionne la carte un
instant), ce qui effaçait toute la progression accumulée et forçait à réaccumuler deux
détections concordantes depuis zéro — potentiellement plusieurs fois de suite.

Deux corrections :
- `lowScoreStreak` tolère désormais jusqu'à 2 ratés isolés avant de vraiment considérer
  que la carte est sortie du champ (`LOW_SCORE_RESET_STREAK = 3`) — un blip ponctuel ne
  coûte plus toute la progression.
- `MAX_CORNER_SHIFT` relevé de 0.02 à 0.035 : le seuil était aussi plus strict que le
  tremblement de main naturel ne le permettait en une seule paire de détections. Le
  filet de sécurité reste le contrôle de netteté après coup (sur l'image réellement
  capturée, pas sur la géométrie estimée) — un seuil plus tolérant ici tente la lecture
  un peu plus tôt, il n'accepte pas une image vraiment floue à sa place.

Vérifié par simulation isolée (logique copiée hors DOM, injouable en conditions réelles
sans caméra) : un raté isolé ne réinitialise plus `prevCorners`, et la comparaison de
stabilité reprend correctement dès le retour d'une bonne détection.

Habillage de l'attente, pendant qu'elle dure encore un peu : le message affiché a
maintenant deux paliers (« Presque… reste immobile » sous 2,5× le seuil de stabilité,
« Stabilise la carte » au-delà) au lieu d'un texte figé — un vrai signal de proximité
basé sur l'écart mesuré, pas une animation cosmétique sans rapport avec l'état réel.

### 4.21 Le numéro est lisible mais ne capture pas : le « / » manquant, pas le seuil
Retour utilisateur juste après §4.20 : « ça capture moins bien, pourtant le numéro
apparaît très bien à l'écran ». Diagnostic réel : plusieurs « numéro illisible »
montrent des chiffres presque intacts mais SANS caractère `/` du tout (`"G MEWn
007763"`, `"GMWno07iise"`) — or `extractNumbers`/`extractNumberCandidates` exigeaient
strictement un `/` littéral (`if(t[i] !== '/') continue`), qu'il soit présent ou non
ailleurs dans le texte. PaddleOCR perd ce trait fin plus facilement que les chiffres
eux-mêmes (premier détail à disparaître sous un léger flou) — un problème préexistant
aux deux chaînes d'extraction (worker ET analyse de file), pas propre au direct,
probablement aggravé par l'assouplissement de §4.20 (plus de frames marginalement
bougées acceptées, le trait fin en pâtit disproportionnellement plus que des chiffres
plus épais).

Repli ajouté aux DEUX fonctions (même logique dupliquée depuis toujours) : si aucun
`/` n'est trouvé nulle part, cherche un bloc de chiffres collés (4-7 chiffres après
normalisation des sosies) et tente un découpage plausible (dénominateur 2-3 chiffres,
numérateur ≤ dénominateur) — jamais en concurrence avec le cas normal (`/` trouvé),
seulement en dernier recours.

Vérifié de bout en bout via le vrai worker (pas une copie) : `"041165"` (sans slash)
→ `41/165` correctement retrouvé ; `"007/165"` (cas normal) inchangé ; `"20 30"`
(chiffres de dégâts, non adjacents) → toujours `illisible`, aucun faux positif.

Limite assumée : un texte doublement corrompu (chiffre ET séparateur perdus, ex.
`"007763"` pour un vrai `"7/165"`) produit un candidat plausible mais FAUX
(`7/763`) plutôt qu'un blocage propre. Risque atténué par le système de confiance
existant (§4.1, §4.13) : sans confirmation du nom, un tel candidat ne peut de toute
façon jamais ressortir en ✅, seulement en 🤔 (ou en « non identifiée » si aucun set
réel ne correspond à ce dénominateur, cas le plus fréquent). Effet de bord à surveiller
sur le prochain diagnostic : une capture de plus peut atterrir dans la file avec un
numéro erroné là où l'ancien comportement se contentait de réessayer silencieusement.

**Correctif suivant, sur ce même repli** : exactement le risque assumé ci-dessus s'est
matérialisé, mais de façon bien plus systématique que prévu. Diagnostic réel :
`num:"1/515"` sur un texte qui ne contient AUCUN numéro (`"Faiblese 2 × 2
Risistance\nHvLanhre\naMwe"`). Cause reproduite exactement : le mot « Résistance »
(présent sur CHAQUE carte Pokémon) contient « isis », que la table de sosies transforme
en « 1515 » — le repli le découpait alors en un faux « 1/515 » plausible. Pas un cas
limite : un mot ordinaire du verso de n'importe quelle carte suffisait à déclencher ça.

Corrigé en exigeant que le bloc retenu contienne au moins **3 vrais chiffres** (pas des
sosies substitués) : un mot n'en contient jamais aucun, un numéro imprimé même mal lu en
contient très majoritairement. Vérifié de bout en bout via le vrai worker : texte
« Résistance » seul → `illisible` (plus de faux positif) ; `"041165"` (sans slash) →
`41/165` toujours récupéré ; `"007/165"` (cas normal) inchangé.

### 4.22 Capturer vite sans cadrage parfait, plutôt qu'attendre un cadrage jugé "sûr"
Retour utilisateur explicite : l'objectif est de capturer sans attendre que la carte
soit parfaitement immobile — l'attente perçue restait frustrante malgré les réglages
successifs de §4.20. Changement d'approche : au lieu d'ajuster encore les seuils d'un
verrou pré-tentative, retirer ce qui rendait un ÉCHEC coûteux, pour pouvoir en tenter
beaucoup sans que ça se voie.

- **Repli sur la bande large retiré** (voir §4.8, mise à jour) : 0 % de succès sur tous
  les relevés réels collectés, mais coûtait le plus cher à chaque échec — le cas le
  plus fréquent avant un cadrage parfait.
- **Verrou de stabilité géométrique retiré comme condition de déclenchement** (il
  exigeait deux détections consécutives concordantes avant même de tenter une lecture) :
  le vrai filet de sécurité contre le flou reste le contrôle de netteté fait APRÈS coup
  sur l'image réellement capturée (`MIN_SHARPNESS`), pas cette comparaison de position.
  Un échec de netteté ou un numéro non trouvé ne coûte plus que ~200 ms maintenant que
  le repli large est retiré — la tentative peut donc se permettre d'être précoce.
  `moved` (écart entre deux détections) reste calculé pour l'indice visuel
  (« Presque… » / « Stabilise la carte »), mais ne bloque plus rien.
- **`MIN_READ_INTERVAL_MS` abaissé de 400 à 150 ms** : cohérent avec le nouveau coût
  d'un échec, on peut se permettre de retenter plus vite.

Le bouton 📸 (capture manuelle) reste en place pour l'instant comme filet de secours,
en vue d'être retiré une fois la capture automatique jugée fiable sans lui.

Vérifié via le vrai worker : lecture normale toujours ~330 ms, un échec (bande serrée
sans numéro) résout maintenant en ~220 ms au lieu de plusieurs secondes.

### 4.23 Diagnostic détaillé par phase + moteur d'exécution (GPU/CPU)
Après plusieurs allers-retours à analyser des durées agrégées à la main (un seul
`ocrMs` par tentative, sans savoir s'il fallait chercher du côté du redressement, de la
netteté ou de l'appel OCR lui-même), le diagnostic devient beaucoup plus précis :

- **Chronométrage par phase**, remonté sur chaque tentative : `tExtract` (redressement
  par perspective, fil principal — seule partie hors Worker), `tCardBmp`
  (redimensionnement avant transfert), `tWorker` (aller-retour Worker complet),
  et côté Worker `tPrep`/`tSharp`/`tEnsure`/`tRecognize` (l'appel `recognize()`
  lui-même — le vrai plancher du moteur OCR). Objectif : voir directement où le temps
  passe plutôt que le deviner.
- **Moteur d'exécution réellement utilisé (GPU/WebGPU vs CPU/WASM)**, jusqu'ici
  invisible : `ppu-paddle-ocr` tente WebGPU par défaut avec repli automatique sur WASM
  (`getDefaultWebExecutionProviders()`, découvert en inspectant le paquet). Capturé via
  `svc.options.session.executionProviders` après `initialize()` — `protected` n'existe
  qu'au sens TypeScript (effacé à la compilation), donc lisible tel quel à l'exécution.
  Nuance honnête : ce champ reflète la liste demandée sauf si le rappel de repli de la
  librairie l'a réécrite suite à une exception JS explicite — un échec interne
  silencieux d'ONNX Runtime (webgpu→wasm sans lever d'exception à ce niveau) ne serait
  pas forcément visible de cette façon précise. Reste un signal directionnel utile :
  test sur cette machine, valeur renvoyée `["cpu"]` malgré une requête
  `["webgpu","wasm"]` et un GPU détecté disponible (`isWebGpuAvailable()` → `true`) —
  confirme au moins que ce n'est PAS `webgpu` qui tourne ici.
- **Diagnostic d'environnement**, une fois par démarrage caméra : cœurs CPU
  (`hardwareConcurrency`), mémoire estimée (`deviceMemory`, absent sur certains
  navigateurs), isolation cross-origin, type de réseau, durée d'initialisation OCR.
- **`api/log.js?format=stats`** : résumé agrégé côté serveur (compte par issue,
  min/moyenne/médiane/max par phase, overall et par issue) — évite de recalculer ça à la
  main sur chaque relevé.

**Bug trouvé en testant, préexistant (commit `cb494cb`, pas introduit aujourd'hui)** :
`ocrReadyForCamera` n'était jamais déclaré (`let`), seulement assigné dans
`startAimLoop()` — une assignation à une variable non déclarée crée une globale
implicite en mode non strict, mais SEULEMENT une fois cette ligne exécutée au moins
une fois. Résultat : ouvrir « voir » (le diagnostic) AVANT le tout premier démarrage de
la caméra levait une `ReferenceError` et cassait `buildDiagReport()` en entier,
silencieusement — repéré en testant la case précisément avant d'avoir démarré la
caméra dans ce test. Corrigé par une déclaration `let` explicite.

### 4.24 Le plancher est maintenant l'appel recognize() lui-même — CPU confirmé, pas GPU
Premier relevé exploitant le diagnostic détaillé (§4.23) : sur 19 tentatives,
`tRecognize` (l'appel OCR proprement dit) coûte en moyenne **1717 ms** (médiane
1652 ms) — environ **80 % du temps total** (2152 ms en moyenne). Tout le reste du
pipeline (redressement, redimensionnement, préparation, netteté) ne pèse que
quelques centaines de ms cumulées. Conclusion directe : il ne reste plus rien à
gratter côté orchestration applicative — ce qui reste est le coût de calcul brut du
moteur OCR sur cet appareil.

Le diagnostic d'environnement confirme aussi `moteurDemandé=["webgpu","wasm"]` mais
`moteurRéel=["cpu"]` : un GPU est bien détecté disponible (`isWebGpuAvailable()` →
`true`, sinon `webgpu` n'aurait pas été demandé du tout), mais l'inférence tourne
quand même sur CPU pur.

**Creusé plus loin** : un intercepteur temporaire de `console.warn` posé autour de
`initialize()` (la librairie journalise elle-même tout repli déclenché par une
exception JS à la création de session) n'a capté **aucun avertissement**
(`fallbackWarnings: null`) — le passage de webgpu à cpu ne lève donc pas d'exception
à cet endroit. Cela suggère que `webgpu` n'est probablement pas un fournisseur
d'exécution réellement opérationnel dans cette configuration de librairie
(bundle onnxruntime-web utilisé), plutôt qu'un échec propre à un appareil précis —
la bascule vers un vrai GPU (WebGPU natif, hors de cette librairie) resterait un
chantier bien plus lourd, pour un résultat incertain, tel qu'évalué plus tôt (§4.7).

**Modèle quantifié re-testé, cette fois en forçant `wasm` explicitement des deux
côtés** (contexte CPU pur, fidèle à ce qui tourne réellement sur l'appareil — le
premier test, §4.24 précédent en discussion, tournait sur un GPU de bureau où l'écart
pouvait ne pas se transposer) : `v6-tiny` (actuel) à ~67 ms par appel contre
`v5-en-mobile-int8` à ~137 ms — le modèle actuel reste le plus rapide, cette fois de
façon non ambiguë (même fournisseur d'exécution forcé des deux côtés, comparaison
propre). Confirme la conclusion précédente sur des bases plus solides : ne pas
changer de modèle.

### 4.25 Sélecteur de zoom manuel
Demande directe (l'utilisateur a vu ce contrôle dans une appli concurrente) : donner la
main sur l'objectif/zoom plutôt que de dépendre uniquement de l'auto-réglage à 1x
(§4.17), qui peut ne pas suffire selon l'appareil. Boutons remplis dynamiquement à
partir de `track.getCapabilities().zoom` (`min`/`max` réels de l'appareil) — jamais une
liste 0.6/1/2/3 devinée à l'avance : `[min, 1, 2, 3, max]` filtré à la plage réelle,
dédupliqué, arrondi à 0,1 près. Masqué et vidé entièrement si l'appareil ne déclare
aucune capacité de zoom (pas de contrôle qui ne ferait rien). Clic → simple
`track.applyConstraints({advanced:[{zoom}]})`, avec le réglage réel remonté au
diagnostic caméra existant en cas d'échec.

Vérifié avec des `track` factices reproduisant deux profils (0,6-5x façon Samsung
multi-objectifs, et 1-8x) : boutons corrects dans les deux cas, mise en évidence du
palier actif, application réelle de la contrainte au clic, et masquage propre quand la
capacité est absente.

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
8. En-têtes COOP/COEP (`vercel.json`) — testés puis retirés (§4.18) : régression de
   vitesse OCR constatée sur diagnostic réel (577-1625ms → 2100-3050ms), probablement
   un coût de synchronisation multi-thread supérieur au gain sur cet appareil. À ne pas
   retenter sans un moyen de comparer plusieurs appareils/relevés, pas un seul.
9. Whitelist de caractères (chiffres + `/`) côté `ppu-paddle-ocr` si l'API l'expose — à
   vérifier, pourrait réduire l'espace de recherche du décodeur.
10. Modèle OCR plus léger/quantifié si `ppu-paddle-ocr` en propose une variante — réduirait
    à la fois le poids téléchargé et le temps d'inférence.
11. ~~Mise au point caméra (Samsung)~~ — correctif posé (§4.17), résultat réel à confirmer
    par le prochain diagnostic (capacités remontées).
12. ~~Préchauffage table des sets TCGdex~~ — fait, voir §4.19.

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
