# PokéScan → eBay Lister — dossier de reprise (pour Claude Code)

Ce document sert de contexte complet pour reprendre le développement dans Claude Code. Il décrit l'objectif, ce qui existe déjà (prototype fonctionnel), et le chantier prioritaire identifié : remplacer l'identification par nom (peu fiable) par une lecture du code d'identification imprimé en bas de carte.

## 1. Objectif du projet

Nicolas a un stock de **1000+ cartes Pokémon** à lister sur eBay. Le besoin : un outil qui permette de scanner rapidement (caméra en rafale ou import de photos en masse), d'identifier chaque carte, de préparer une fiche de vente (titre, description, prix, état), puis d'exporter tout ça pour une mise en ligne groupée sur eBay — sans dépendre d'un accès API développeur eBay (non disponible actuellement).

Contrainte forte : le volume (1000+ cartes) impose que chaque étape soit rapide. L'identification manuelle carte par carte est le principal goulot d'étranglement actuel.

## 2. État actuel — prototype fonctionnel livré

Un prototype **HTML/JS/CSS en fichier unique**, sans étape de build, testé et livré à l'utilisateur : `pokemon-ebay-lister.html` (fourni à côté de ce document — à placer à la racine du repo).

### 2.1 Stack technique
- Vanilla JS (pas de framework, pas de bundler), un seul fichier `.html`.
- Dépendances chargées en CDN (`cdnjs.cloudflare.com`) :
  - `jszip@3.10.1` — export des photos en `.zip`.
  - `tesseract.js@7.0.0` — OCR côté navigateur (voir §3).
- Aucun backend. Tout tourne dans le navigateur de l'utilisateur, en local.
- API externe utilisée pour l'identification : **TCGdex** (`https://api.tcgdex.net/v2`), gratuite, sans clé, sans limite documentée — voir §5.3. Remplace l'ancien choix Pokémon TCG API (`api.pokemontcg.io`), abandonné le 2026-08-23 car devenu instable en production (~40-50% d'erreurs 500/502 constatées) et en cours de dépréciation payante (Scrydex). TCGdex gère nativement les cartes en français et fournit des prix Cardmarket (€) en plus de TCGPlayer ($).

### 2.2 Pourquoi un fichier HTML local et pas une page hébergée (Artifact) ?
Ce point est important si le projet évolue : les pages publiées via l'outil "Artifact" (claude.ai) ont une CSP stricte qui **bloque tout fetch/XHR vers un domaine externe**, sans exception possible (vérifié via la skill `artifact-capabilities` : aucune capability ne permet un fetch HTTP générique vers une API tierce). Comme l'app doit interroger `api.pokemontcg.io` en direct depuis le navigateur, elle ne peut pas être une page Artifact hébergée — elle doit être un fichier `.html` ouvert directement par l'utilisateur (ou, plus tard, une vraie webapp déployée ailleurs, ce qui lève cette contrainte — voir §6).

### 2.3 Fonctionnalités actuelles
- **Capture** :
  - Caméra en direct (`getUserMedia`) avec bouton de capture rapide, sans réouverture de l'appareil photo natif entre deux cartes (flash + vibration de confirmation).
  - Import en masse de photos déjà prises (`<input type="file" multiple>`).
  - Photo unique via l'input natif `capture="environment"` en secours.
  - Toutes les photos sont compressées côté client (canvas, redimension max 900px, JPEG q=0.75) avant stockage en mémoire (dataURL).
- **File d'attente** (`pendingQueue`) : les photos capturées/importées s'accumulent, consommées une par une dans l'onglet Identifier. `skippedQueue` pour les cartes passées, récupérables.
- **Identification** (`doSearch`, `quickAdd`) :
  - Recherche texte contre `api.pokemontcg.io/v2/cards?q=name:"..."` (+ filtre optionnel par set).
  - **OCR expérimental** (`runOcrForCurrentPhoto`) : au chargement de chaque photo, crop automatique du **haut** de l'image (28% supérieurs) → passage à Tesseract.js → heuristique `extractNameGuess()` qui prend la 1ère ligne de texte exploitable comme suggestion de nom → pré-remplit la recherche si l'utilisateur n'a pas déjà tapé quelque chose → déclenche la recherche automatiquement.
  - Clic sur un résultat (ou touche Entrée) = ajout **immédiat** au lot (pas d'étape de confirmation intermédiaire), avec animation ✅ et défilement automatique vers la carte suivante. Bouton "Annuler" disponible ~5s après chaque ajout.
  - État (NM/LP/MP/HP/DMG) et quantité sont "collants" (persistent d'une carte à l'autre) pour éviter de les re-sélectionner à chaque fois.
- **Lot** (`batch`) : tableau éditable (SKU, titre, état, prix, quantité, URL image), suppression ligne par ligne.
- **Export** :
  - CSV avec colonnes prêtes pour eBay (SKU, Title, Description, CategoryID=183454 "CCG Individual Cards", ConditionCode, ConditionDescriptorID selon les enums eBay trading cards — voir mapping dans le Guide intégré à l'app —, Price, Currency, Quantity, ImageURL, Game, CardName, Set, CardNumber, Rarity).
  - ZIP des photos (nommées par SKU) — à héberger ailleurs (ImgBB, Postimages...) car eBay exige des URLs publiques pour les images, pas d'upload de fichier local dans son outil de bulk listing natif (Seller Hub → Reports → Uploads, aucun accès API développeur requis).
  - Sauvegarde/rechargement de la progression en `.json` (lot + files d'attente + réglages) pour reprendre sur plusieurs sessions/appareils.
- **Réglages** : clé API Pokémon TCG (optionnelle mais recommandée : 1000 req/jour sans clé vs 20 000/jour avec), devise, % du prix marché TCGPlayer appliqué au prix de vente suggéré, ID de catégorie eBay, templates de titre/description, toggle OCR.

### 2.4 Modèle de données actuel (état en mémoire JS, pas de persistance serveur)
```js
// une entrée de la file d'attente
{ id, photo /* dataURL JPEG compressé */ }

// une entrée du lot (batch), après identification
{
  id, photo, cardName, setName, number, rarity,
  condition, price, qty, title, description, sku,
  imageUrl, categoryId
}
```

### 2.5 Limites connues (déjà documentées dans l'app, onglet Guide)
- Pas de reconnaissance visuelle de la carte entière — uniquement lecture de texte (nom) en haut de carte via OCR, avec confirmation humaine obligatoire.
- Prix suggéré basé sur TCGPlayer (marché US, en $) — à ajuster pour le marché EU/€.
- Pas d'envoi automatique vers eBay (pas d'accès API développeur) — passage par l'import CSV natif eBay.
- OCR ~50-70% de réussite estimée sur le **nom** (police stylisée variable selon les cartes, holo/brillance, angle de prise de vue).

## 3. Chantier prioritaire : identification déterministe via le code bas de carte

### 3.1 Le problème actuel
L'OCR actuel cible le **nom du Pokémon**, imprimé en haut de la carte dans une police qui varie énormément selon l'époque/l'illustration (base set, holo, full art, promo...). Résultat : lecture peu fiable, et même quand l'OCR réussit, la recherche par nom renvoie souvent **plusieurs cartes homonymes** (même Pokémon dans différents sets/rééditions) qu'il faut ensuite trier visuellement à la main.

### 3.2 L'idée proposée par Nicolas
Les cartes Pokémon portent, imprimé en bas de carte, un identifiant compact et standardisé : **code du set + langue + numéro de collection** — exemple donné : `MEW fr 18` (set "151"/MEW, carte française, numéro 18).

C'est une bien meilleure cible pour l'OCR que le nom, pour plusieurs raisons :
- **Police fixe, petite, uniforme** sur toutes les cartes modernes (contrairement au nom, très stylisé et variable).
- **Position fixe** (bas de carte), donc un crop précis de la zone réduit énormément le bruit pour l'OCR.
- **Résultat déterministe** : set + numéro identifie une carte de façon quasi unique, alors qu'un nom seul est ambigu (des dizaines de "Pikachu" existent).

### 3.3 Ce qui est confirmé par la recherche, et ce qui reste à vérifier

**Confirmé (documentation officielle/guides communautaires) :**
- Le **bas-droit** d'une carte Pokémon moderne (ère Diamond & Pearl et après) affiche le numéro de collection au format `XXX/YYY` (numéro de la carte / total imprimé du set), accompagné du symbole du set et souvent d'un symbole de rareté.
- Le **bas-gauche** affiche classiquement "Illus. [nom de l'illustrateur]" suivi de la **regulation mark** (une lettre A à H depuis Sword & Shield), utilisée pour déterminer la légalité en format Standard.
- L'API Pokémon TCG expose un champ `set.ptcgoCode` (ex: `"MEW"` très probablement pour le set 151, `"SSH"` pour Sword & Shield...) — c'est vraisemblablement le code que Nicolas voit imprimé sur ses cartes. L'API expose aussi `card.number` (numéro brut, ex `"18"`) et `card.set.printedTotal`/`card.set.total`.

**Non confirmé — à vérifier en tout début de chantier, sur de vraies photos de cartes physiques :**
- La position exacte et le format exact du code observé par Nicolas (`MEW fr 18`) — s'agit-il d'une seule ligne combinée (set + langue + numéro), ou de plusieurs éléments visuellement proches mais techniquement séparés (ex: le `set.ptcgoCode` fait partie de la mention légale en tout petit près du copyright, distincte du numéro `XXX/YYY` habituellement en bas-droite) ? Les cartes en français ont-elles une mise en page identique aux cartes anglaises pour cette zone ?
- Est-ce que le champ `ptcgoCode` est réellement interrogeable via la recherche Lucene de l'API (`q=set.ptcgoCode:MEW number:18`) ? À tester dès le départ — sinon il faudra passer par une table de correspondance locale code↔set (ex: télécharger `/v2/sets` une fois et construire un mapping `ptcgoCode → set.id`).
- Le marqueur de langue ("fr") — l'API Pokémon TCG est **centrée sur les cartes anglaises** (images, texte, prix TCGPlayer). Une carte française et sa version anglaise partagent normalement le même set/numéro/rareté, donc le matching restera valide pour identifier *quelle carte c'est*, mais il faut décider si la langue sert seulement à confirmer/logguer, ou si elle influence le pricing/description (une carte FR peut avoir une cote différente d'une carte EN sur le marché réel).

**Action recommandée en tout début de session Claude Code** : prendre 5-10 photos macro bien cadrées du bas de carte sur des cartes physiques variées (sets différents, langues différentes si possible), les inspecter à l'œil et/ou via un test OCR rapide, pour figer le format exact avant de coder le parsing. Ne pas coder le parsing "à l'aveugle" sur la seule base de ce document.

### 3.4 Piste technique concrète

1. **Crop ciblé** : au lieu de cropper le haut de la carte (comme aujourd'hui), cropper une bande fine en bas de carte (ex: derniers 12-15% de hauteur), potentiellement scindée en deux sous-zones (bas-gauche pour set/langue, bas-droite pour le numéro `XXX/YYY`) si le format se confirme séparé.
2. **OCR ciblé** sur cette bande, avec une whitelist de caractères Tesseract restreinte (lettres majuscules + chiffres + `/`) pour améliorer la précision — Tesseract.js supporte `setParameters({tessedit_char_whitelist: ...})`.
3. **Parsing** : regex pour extraire le numéro (`\d{1,3}\s*\/\s*\d{1,3}` ou juste `\d{1,3}`) et le code de set (suite de lettres majuscules de 2-6 caractères).
4. **Résolution déterministe** :
   - Charger `/v2/sets` une fois (mise en cache locale, ~165+ sets, ne change pas souvent) pour construire une table `ptcgoCode → set.id/set.name`.
   - Requêter `/v2/cards?q=set.id:{id} number:{number}` → normalement **un seul résultat**, à afficher pour confirmation en un coup d'œil (plus besoin de trier une liste) au lieu de la recherche floue par nom actuelle.
   - Fallback vers la recherche par nom (comportement actuel) si le crop bas échoue ou si aucun résultat exact n'est trouvé.
5. **Combiner avec l'OCR nom existant** en filet de sécurité : si le code bas-carte donne un candidat ET que l'OCR nom (déjà en place) est cohérent avec ce candidat, la confiance est très haute ; sinon flaguer pour vérification manuelle plus visible.

### 3.5 Pourquoi ça change la donne pour le volume (1000+ cartes)
Avec un matching quasi déterministe, le flux "Identifier" pourrait passer de *"taper/vérifier un nom, choisir parmi plusieurs résultats"* à *"un seul résultat pré-sélectionné, un coup d'œil, Entrée"* — ce qui rapproche l'outil d'un vrai scan automatique tout en gardant la confirmation humaine (donc sans le risque d'une IA qui se trompe silencieusement sur une annonce à publier).

## 4. Roadmap suggérée (priorisée)

1. **Valider le format réel du code bas de carte** sur des photos physiques (voir §3.3) avant d'écrire du code de parsing.
2. Implémenter le crop bas + OCR ciblé + parsing + résolution déterministe via `/v2/sets` + `/v2/cards`, en gardant l'OCR nom actuel en fallback.
3. Comparer empiriquement le taux de réussite avant/après sur un échantillon réel (ex: 50 cartes) avant de généraliser.
4. Explorer une whitelist de caractères Tesseract et un pré-traitement d'image (contraste, seuillage) spécifique à cette zone pour améliorer encore la précision.
5. Envisager de sortir du fichier HTML unique vers un petit projet structuré (voir §6) si la complexité grandit (plusieurs modules OCR/API/export deviennent difficiles à maintenir dans un seul fichier).
6. Revoir le pricing pour le marché EU (actuellement basé sur TCGPlayer USD) — chercher une source de prix européenne (Cardmarket, que l'API expose déjà via `card.cardmarket` dans certains cas — à vérifier, non exploité actuellement dans le prototype).
7. Surveiller la dépréciation de l'API pokemontcg.io au profit de Scrydex (payant) — prévoir un plan B si l'accès gratuit disparaît (voir §5.3).

## 5. Notes / risques à garder en tête

### 5.1 Contrainte plateforme (rappel §2.2)
Toute évolution vers une page hébergée (partageable par URL) devra soit passer par un vrai déploiement web (hors claude.ai Artifact), soit garder le modèle "fichier local ouvert dans le navigateur".

### 5.2 Clé API
Obsolète : TCGdex ne nécessite aucune clé. L'ancienne clé Pokémon TCG API en dur dans les Réglages a été retirée du fichier lors de la bascule vers TCGdex (2026-08-23).

### 5.3 Dépendance externe — historique
`api.pokemontcg.io` a été abandonné (2026-08-23) : instable en test (~40-50% d'erreurs 500/502 sur un échantillon), et en cours de migration vers **Scrydex** (payant). Remplacé par **TCGdex** (`api.tcgdex.net`, gratuit, sans clé), qui s'est montré fiable (5/5 puis 8/8 requêtes réussies en test) et couvre nativement le français + le pricing Cardmarket EUR. Reste un risque générique à garder en tête pour tout projet dépendant d'une API tierce gratuite : TCGdex est un projet communautaire, pas de SLA — à resurveiller si le volume de scans augmente fortement.

Pour le chantier §3.4 (résolution déterministe via le code bas de carte) : le champ `set.ptcgoCode` de l'ancienne API devient `set.abbreviation.official` chez TCGdex (vérifié : `MEW` pour le set "151", correspond bien à ce que Nicolas voit imprimé sur ses cartes), et `card.number` devient `card.localId`. Endpoint carte unique : `/v2/fr/cards/{setId}-{localId}` (ex: `base1-58`) — pas besoin de recharger `/v2/sets` pour la résolution finale si le crop OCR donne directement `setId` et `localId`, seulement pour construire la table `abbreviation → setId` en amont.

### 5.4 Sandbox de développement
Le prototype a été développé et testé (Playwright, navigateur headless) dans un environnement dont l'accès réseau sortant est restreint (proxy avec allowlist) — `api.pokemontcg.io` et `cdnjs.cloudflare.com` n'étaient pas joignables directement depuis cet environnement pour du test en conditions réelles. Les tests ont donc mocké `Tesseract`/le fetch API où nécessaire. À faire dans Claude Code (ou tout environnement avec accès réseau complet) : un test end-to-end réel contre l'API live.

## 6. Fichiers du projet

- `pokemon-ebay-lister.html` — le prototype fonctionnel actuel (fichier unique, à la racine).
- `PROJECT.md` — ce document.

Aucun repo git n'a encore été initialisé à ce stade — c'est la première étape naturelle en reprenant dans Claude Code (`git init`, `.gitignore` pour ne pas committer la clé API en clair, etc.).

## 7. Références utiles

- [TCGdex — docs REST API (source actuelle)](https://tcgdex.dev/rest)
- [Pokémon TCG API — docs (ancienne source, abandonnée)](https://docs.pokemontcg.io/)
- [Scrydex FAQ (successeur payant de pokemontcg.io)](https://scrydex.com/faq)
- [Comment lire les symboles/numéros de set Pokémon (ChaseDex)](https://chasedex.com/guides/sets-symbols-and-abbreviations/)
- [eBay — condition descriptor IDs pour trading cards](https://developer.ebay.com/api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html)
- [eBay — bulk upload via Seller Hub Reports (sans API développeur)](https://www.img.vision/handbook/ebay/bulk/seller-hub-reports/)
- [Tesseract.js](https://tesseract.projectnaptha.com/)
