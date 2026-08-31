# Reprise du projet — note de passation

Pour une nouvelle instance Claude Code qui reprend PokéScan. Lis d'abord ce fichier,
puis `PROJECT.md` (dossier complet, §4.55 pour la V2) et la mémoire
(`C:\Users\Aruna\.claude\projects\C--Users-Aruna-pokescan\memory\` — `MEMORY.md` est
l'index ; `scanner-test.md` raconte tout le chantier V2 ; `r2-packs.md` le stockage).

## Le projet en deux lignes

Scanner de cartes Pokémon (et TCG) → listing eBay. Une seule page `index.html` (~20 k
lignes, JS vanilla, pas de build). Déployé sur `poke-scan-drab.vercel.app` (Vercel,
auto-deploy à chaque push sur `main` de `DLTAruna/PokeScan`). Ambition affichée : être le
n°1 des scanners.

Commits en français, style sobre/littéraire. Terminer par
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Git user « Nikos ».
**Claude commite ET pousse lui-même** (autorisation donnée par Nikos le 2026-08-31 ; la
consigne antérieure « c'est Nikos qui pousse » ne vaut plus). Chaque push part en
déploiement Vercel automatique — donc pousser du travail vérifié, et dire ce qui ne l'est
pas encore.

**⚠️ `VERSION_APP` (dans `index.html`, juste après `BUILD_VERSION`) : +1 À CHAQUE PUSH.**
C'est le « V.n » affiché en haut à droite (en-tête sur téléphone, barre latérale au-delà
de 1024 px) : Nikos vérifie d'un coup d'œil que son téléphone a bien pris le déploiement,
le service worker pouvant servir la version d'avant sans le dire. Le numéro part aussi
dans `/api/scan-log` (champ `v`), donc les logs disent quelle version a produit chaque
scan. Annoncer le numéro en même temps que le push (« poussé en V.4 »), sinon il ne sert
à rien. `BUILD_VERSION` (horodatage déduit de `document.lastModified`) reste le recours
automatique en cas de doute — il est dans l'infobulle du badge.

## ⚠️ Le piège `qualite` en V2 (V.2) — à connaître avant de toucher au scanner

En V2, `demarrerQualite()` coupe l'échantillonnage et `arreterQualite()` remet `qualite`
à **zéro**. Rien ne le réécrit ensuite. Tout code qui lit `qualite` en V2 lit donc des
zéros, et les interprète comme « image catastrophique ». Deux fonctions s'y sont fait
prendre, et ça coûtait cher :

- `indiceVisee()` — `qualite.net = 0 < 0.4` → **tous** les messages de la V2 devenaient
  « Flou — éloigne un peu le téléphone », y compris sur une carte nette.
- `surveillerNettete()` — `netBrut = 0 < NET_MIN` → au bout de 2,5 s elle **changeait le
  zoom de la caméra**, palier par palier. Chaque changement force une remise au point : la
  carte devenait vraiment floue, bougeait, `v2StableStreak` repartait à zéro. Toutes les
  2,5 s. **C'était l'essentiel du délai ressenti en auto** — le correctif contre le flou
  fabriquait le flou.

**Règle posée : aucun lecteur de `qualite` ne doit agir quand `qualiteTimer` est nul.**
La garde porte sur la mesure, pas sur le mode — un futur mode qui coupe l'échantillonnage
est couvert d'office. Si tu ajoutes un lecteur de `qualite`, mets cette garde.

## Où on en est (2026-08-31, nuit — commit `d336e61`)

**Tout est poussé** (la section « Non poussé » plus bas était périmée, elle a été retirée).

Dernière passe, à partir des logs de la session de 20h44 (17 scans) :

- **Worker Cloudflare déployé** par Nikos → `https://pokescan-orb.inox62.workers.dev`,
  posé dans `WORKER_ORB` (`scan-v2.js`). Vérifié en local : 1 requête par scan au lieu de
  ~15, plus aucun appel direct à `r2.dev/orb/`. C'était le poste `T.refs` (médiane 667 ms,
  pics à 1 380).
- **OCR resserré** : `orbEgalite = inl >= 25 && dominance < 0.6`. Sur 15 lancements réels
  il n'a changé le verdict que 2 fois (inliers 35 et 53, dominance 0,57 et 0) ; les 13
  autres avaient ≤ 20 inliers et coûtaient 0,3 à 4,3 s pour rien. Re-test 31 photos :
  **2 OCR seulement, 25/31 justes, 23/24 des sûres** — inchangé.
- **Lenteur du mode auto = le déclenchement, pas l'identification** (constat de Nikos : la
  prise manuelle est immédiate). Cause trouvée : le verrou « déjà lue » se relâchait sur
  `cardConfirmedAbsentSinceCapture`, qui exige **4 images ET 1,2 s de champ vide** — il
  fallait montrer du vide entre chaque carte. Remplacé en V2 par `v2CarteRetiree` /
  `v2AbsenceStreak` (2 images, ~300 ms) ; le filet reste `gererScanV2` qui compare la carte
  identifiée à la précédente. Tolérance de position ramenée de ×8 à ×4 / ×2,5 : le ×8 posé
  contre les doubles ne les empêchait pas (ils naissent de cartes **en transit**, donc hors
  tolérance) et bloquait la carte suivante posée au même endroit du cadre.
- **« sv03.5 puis 151 » dans le panneau du bas** : pas deux scanners, juste
  `carteDepuisPack` qui mettait l'identifiant du set comme nom en attendant la fiche
  complète. Résolu par `nomDeSet()` tout de suite, vide sinon.

**À vérifier sur téléphone à la prochaine session** : cadence carte-à-carte (le point
central), gain réel du Worker sur `T.refs`, et si les doubles reviennent maintenant que la
tolérance est plus basse.

## État antérieur (2026-08-31, soir)

Le gros chantier = **Scanner V2**, identification par l'**illustration** au lieu du numéro.
Chaîne : DINOv2 (embedding) → shortlist → ORB + homographie RANSAC reclasse → OCR du
numéro départage en cas de doute. Code dans **`scan-v2.js`** (module autonome, ses propres
Workers), branché dans `index.html` via `<script type="module">` en bas + le hook
`gererScanV2()` dans `attemptRead()` **et** dans `captureFrame()` (prise manuelle).

**État : fonctionne, en cours de réglage sur le téléphone de Nikos.** L'identification est
bonne ; c'est la latence et l'ergonomie du déclenchement qu'on peaufine, session de test
après session de test, via `/api/scan-log`.

### Fait et déployé (jusqu'à `86e2581`)

- **V2 « tous sets, aucun choix »**. Activation : case dans ⚙️ ou pastille dans la caméra.
  Plus aucune sélection de set.
- **Index d'empreintes global** sur R2 : `index-global.bin` (int8, ~3 Mo, **7 591 cartes**
  = séries **swsh + sv + me**) + `index-global-meta.json.gz`. Téléchargé une fois, gardé
  en IndexedDB (`pokescan_v2`).
- **Descripteurs ORB par carte** : blob `orb/<clé>.orb` (~25 Ko), récupéré à la demande
  pour les ~18 cartes de la shortlist, puis gardé (LRU 900).
- Sélecteur **V1 / V2** (V1 = numéro, V2 = illustration). En V2 : les 3 jauges
  netteté/lumière/cadrage sont **masquées** (elles ne conditionnent rien) ; seules les
  équerres du cadre restent.
- **Aucun repli sur l'OCR en V2** : `gererScanV2` gère ses échecs — 2 essais (« recentre la
  carte »), au 3e la photo part dans « À vérifier ».
- **Prise manuelle 📸 identifie aussi** (`7035bec`, voir plus bas) : passe par
  `gererScanV2`, affiche le résultat dans le panneau du bas comme la capture auto.
- Import du module : **`./scan-v2.js?v=14`** dans `index.html` (bumper à chaque modif de
  `scan-v2.js`).

### Ce qui reste

1. **Valider sur téléphone la passe `d336e61`** (cadence carte-à-carte, `T.refs` avec le
   Worker, retour éventuel des doubles). Reste à surveiller côté moteur :
   - **WebGPU capricieux** sur ce téléphone (tantôt `webgpu/fp16`, tantôt `wasm/q8` — il
     met ~8 scans à s'initialiser) **et ne gagne quasi rien** (fp16 ~650 ms ≈ WASM).
     Ne pas s'acharner dessus.
   - **`T.orb` dérive sur la salve** (360 ms au début → 900-1 600 ms au 15e scan) malgré
     `recyclerOrbSiBesoin()` tous les 12 scans : c'est du throttle thermique, pas de la
     fragmentation. Le recyclage n'y change rien de visible — à réévaluer.
   - **`chargerSetComplet()` (mode « classeur ») télécharge ~5 Mo en fond** dès 3 picks du
     même set, alors que `packTelecharge` reste vrai ensuite (la shortlist est cross-set).
     Il coûte de la bande passante mobile sur le chemin critique pour un gain non mesuré —
     candidat sérieux à la suppression, à trancher avec Nikos.
2. **Révoquer le jeton R2 fuité** — était en clair dans `run.sh` au commit `872c039`
   (poussé sur GitHub). Cloudflare → R2 → Manage R2 API Tokens → supprimer. En refaire un
   pour les builds suivants, le mettre dans `tools/build-packs/.env` (non commité).
3. **Étendre la tranche** aux séries antérieures (`base,neo,ecard,ex,pop,dp,pl,hgss,col,bw,
   xy,sm`) quand la V2 sera validée. `SERIES=base,neo,... bash tools/build-packs/run.sh` —
   le script reprend et reconstruit l'index global avec tout. Compter ~2 h de plus.
   Les 3 `rebut` de la session de 20h44 (`swsh10-082`, `swsh5-79`, `sv03-175` — clés
   prédites, donc fausses) étaient sans doute des cartes hors tranche.
4. **Le log ne mesure pas la justesse** : `predit == attendu == cardId` (tous mis à la
   prédiction). Il faut que Nikos corrige les cartes fausses (→ `verifie:true`) ou dise ce
   qui a raté. Les tests navigateur sur `photos-test/`, eux, connaissent la vérité.

## R2 (stockage de l'index V2)

- Bucket **`pokescan-packs`**, compte Cloudflare de Nikos.
  Account ID `8a7457771cfa724d62c8fd4fb97dbaf9`.
  URL publique `https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev`.
- CORS posé (dashboard) pour `poke-scan-drab.vercel.app` + `http://localhost:8802`.
- Objets : `index-global.bin`, `index-global-meta.json.gz`, `manifest.json`, `status.json`,
  `pack-<set>.pack` (un par set, format navigateur), `orb/<clé>.orb` (un par carte).
- Clés d'écriture : `tools/build-packs/.env` (non commité, à recréer après révocation).
- `api/pack.js` (gist, **pas** R2) sert encore `scanner-test.html` — ne pas y toucher.
- `api/build-control.js` (gist) : pilotage du build depuis `build.html`.
- `api/scan-log.js` (gist, fichier `pokescan-scan.log`) : relais des scans V2.

## Outils de build — `tools/build-packs/`

```bash
cd tools/build-packs
npm i --include=optional --os=win32 --cpu=x64          # voir pièges ci-dessous
# .env :  R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=  R2_BUCKET=pokescan-packs
SERIES=swsh,sv,me bash run.sh                          # build une tranche, reprend après crash
```

- `index.mjs` — construit embeddings + ORB + dHash (format navigateur exact), envoie packs
  + blobs + `index-global.bin` + `manifest.json` sur R2, écrit `status.json` en continu.
- `run.sh` — boucle de relance. `lib.mjs` — fonctions partagées.
- `split-orb.mjs` — redécoupe des packs R2 en blobs par carte (le builder le fait tout seul
  désormais ; utile pour rattraper d'anciens packs).
- `verify-orb.mjs` / `verify-global.mjs` — fidélité Node↔navigateur (embeddings 207/207,
  ORB self=700) et recall de shortlist (100 % top-30 sur 7 591 cartes).
- **`build.html`** (racine, déployé) — tableau de bord live lisant `status.json`.
- Build complet ~2 h pour 7 591 cartes (~585 ms/carte : dl 166 + emb 218 + orb 170 + hash 30).

### Pièges d'install (machine de Nikos, Windows)

- **`onnxruntime-node` 1.21 crashe au chargement DLL** → forcé en **1.20.1** via
  `"overrides"` dans `tools/build-packs/package.json`.
- **`sharp` 0.35 ne charge pas** → **0.34.5**, avec `npm i --include=optional --os=win32
  --cpu=x64`.
- Test de fidélité fait : le décodage `sharp` (Node) donne des embeddings et un ORB
  interchangeables avec le navigateur → on construit tout hors appareil sans risque.

## Tester la V2 en local

```bash
npx serve -l 8802 .        # ou l'outil preview_start name "pokescan" (.claude/launch.json existe)
```

Puis `http://localhost:8802/index.html?v2`. Dans la console :

```js
await window.SCAN_V2.initV2({onProgress:(p,m)=>console.log(m)});
window.SCAN_V2.moteurV2();  window.SCAN_V2.diagV2();          // moteur + raisons d'échec + warm1/warm2
// vraie photo, redressement réel de l'app :
const dew = await window.redresserPhotoImportee('/photos-test/PKMN-151-025-40899.jpg');
await window.SCAN_V2.identifierV2(dew);
// chaîne complète (panneau du bas + lot) :
window.v2DerniereCle = null; await window.gererScanV2(dew, null, 1, performance.now());
```

- `photos-test/` : 31 vraies photos (set 151, = `sv03.5`), servies en même origine. Cartes
  en paysage → `redresserPhotoImportee` fait le redressement comme l'app.
- Images `assets.tcgdex.net` : **pas de CORS**, impossible de les dessiner sur un canvas
  cross-origin. Passer par `photos-test/`.
- Le navigateur intégré a un **WebGPU logiciel** (lent, ~450 ms pour l'emb) — pas
  représentatif ; sur GPU réel c'est plus rapide.
- Résultat de référence des tests navigateur (31 photos, index 7 591) : **25/31 exactes,
  ~24/25 des « sûres » exactes** (la ou les erreurs « sûres » = photos mal étiquetées
  connues : #169 montre en fait la #168). Les ratés restants sont tous en `douteuse` /
  `rebut`, jamais affichés avec assurance.

## Lire les logs de scan (retours téléphone)

Naviguer le navigateur intégré **sur le domaine Vercel d'abord** (`https://poke-scan-drab.
vercel.app/`), puis `fetch('/api/scan-log?format=json')` en console (same-origin). Ou
naviguer direct sur `.../api/scan-log?format=json` et lire le corps.

Par entrée : `predit`, `categorie` (`sure`/`douteuse`/`rebut`), `fiabilite`, `inliers`,
`marge`, `ms`, `T:{emb,refs,orb,ocr}`, `moteur`, `diag`, `packTelecharge`, `sets`,
`ocrLance`, `ocrOk`. `?format=clear` pour vider avant une session.

## Réglages clés de `scan-v2.js`

- `SHORT = 18` · `NFQ = 360` (points d'intérêt de la requête) · homographie sur les 8 premiers.
- `INLIERS_MIN = 10` — sous ce seuil sans OCR concordant → `rebut` (on ne devine pas).
- `geoFranche = inl >= 20 && dom >= 0.6` → `sure` même si la sigmoïde est basse (~77 %).
- `MAX_CARTES_ORB = 900` — descripteurs gardés en mémoire du worker (LRU).
- `recyclerOrbSiBesoin()` — worker ORB recyclé tous les 12 scans (fragmentation du tas WASM
  d'OpenCV). Réinjection depuis le cache IDB au scan suivant.
- OCR sauté si `dernierOrbMs >= 1800` (session chaude — l'OCR y prendrait > 3 s).
- `INLIERS_MIN = 10` — sous ce seuil sans OCR concordant → `rebut`.
- `noterPickV2()` — 3 picks du même set → charge le pack entier en fond (« mode classeur » ;
  aide peu en pratique car la shortlist est cross-set).
- `WORKER_ORB = 'https://pokescan-orb.inox62.workers.dev'` — Worker Cloudflare déployé,
  regroupe les blobs ORB d'un scan en 1 requête (repli auto par carte s'il ne répond pas).
- `orbEgalite = inl >= 25 && dominance < 0.6` — seule condition qui lance l'OCR.
- Moteur emb : essais `webgpu/fp16 → fp32 → q4 → wasm/q8 → wasm/fp32`.

## Réglages clés côté `index.html` (V2)

- `detectLoop()` branche V2 (~ligne 11130) : déclenche sur `d.score >= 0.5 && stable`
  (`v2StableStreak >= 2`), **aucune** dépendance aux jauges. `dejaLue` empêche de
  re-scanner une carte déjà lue et toujours en place ; il se relâche sur `v2CarteRetiree`
  (2 images sous le seuil, ~300 ms — **pas** la preuve d'absence V1 à 1,2 s, qui rendait le
  mode auto deux fois plus lent que le manuel) ou sur un vrai déplacement de la carte.
- `attemptRead()` hook V2 (~ligne 11440) : `gererScanV2()` gère tout, jamais de repli OCR.
  Retours : `'traite'` / `'rebut'` / `'reessai'` / `'rejet-doublon'`.
- `gererScanV2()` (~ligne 12025) : identif → si rebut, 2 `'reessai'` puis
  `capturerSansLecture`. Succès : `showLiveResultPending` (photo prise) + `showLiveResultDone`
  (depuis le pack) tout de suite, fiche complète + validation auto en arrière-plan.
- `captureFrame()` / `captureFrameInterne()` (~ligne 12517) : prise manuelle, route par
  `gererScanV2` si V2 actif.
- `demarrerQualite()` / `majJaugesSelonMode()` : masquent les jauges + coupent
  l'échantillonnage quand V2 actif.
- `SCAN_V2.relayV2({...})` appelé dans `gererScanV2` (succès et rebut) → `/api/scan-log`.
