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

## Où on en est (2026-08-31)

Le gros chantier en cours = **Scanner V2**, l'identification par l'**illustration** au lieu
du numéro. Mesuré : ~90-97 % de rang 1 contre ~64 % pour l'OCR du numéro.

Chaîne : DINOv2 (embedding) → shortlist → ORB + homographie RANSAC reclasse → OCR du
numéro départage en cas de doute. Code dans **`scan-v2.js`** (module autonome, ses propres
Workers), branché dans `index.html` via `<script type="module">` en bas + le hook
`gererScanV2()` dans `attemptRead()`.

### Ce qui est fait et déployé

- **V2 « tous sets, aucun choix »**. L'utilisateur active la V2 (case dans ⚙️ ou pastille
  dans la caméra) et scanne n'importe quelle carte — plus de sélection de set.
- **Index d'empreintes global** sur R2 : `index-global.bin` (int8, ~3 Mo, 7 591 cartes =
  séries **swsh + sv + me**) + `index-global-meta.json.gz`. Téléchargé une fois, gardé en
  IndexedDB (`pokescan_v2`).
- **Descripteurs ORB par carte** : blob `orb/<clé>.orb` (~25 Ko) récupéré à la demande pour
  les ~18 cartes de la shortlist de chaque scan, puis gardé (LRU 900 cartes).
- Sélecteur **V1 / V2** conservé. V1 = lecture du numéro (l'existant), V2 = illustration.
- Import du module : `./scan-v2.js?v=10` dans `index.html` (bumper à chaque modif de
  `scan-v2.js`).
- **Tests navigateur** (31 photos réelles set 151, index 7 591, vrai redressement) :
  25/31 exactes, 25/26 des « sûres » exactes (la 26e erreur « sûre » = photo mal
  étiquetée, connue). Latence ~0,9-1,2 s/scan sur WebGPU.

### Ce qui reste

1. **Nikos teste la V2 sur son téléphone** (version `?v=10`). Retour attendu via
   `/api/scan-log`. Le point ouvert de la dernière session : c'était lent (emb sur CPU
   parce que le GPU du téléphone rejette fp16) — corrigé en tentant `webgpu/fp32` avant
   WASM ; `diagV2()` remonte pourquoi le GPU échoue. **À confirmer sur l'appareil.**
2. **1 commit local non poussé** : `2b91aec` (optimisations vitesse). `git push origin main`
   quand Nikos valide (le push est parfois bloqué pour Claude par le classificateur — c'est
   Nikos qui pousse).
3. **Révoquer le jeton R2 fuité** — il était en clair dans `run.sh` au commit `872c039`
   (poussé sur GitHub). Cloudflare → R2 → Manage API Tokens → supprimer. En refaire un pour
   les builds suivants (le mettre dans `tools/build-packs/.env`, non commité).
4. **Étendre la tranche** aux séries antérieures (`base`, `neo`, `ecard`, `ex`, `pop`,
   `dp`, `pl`, `hgss`, `col`, `bw`, `xy`, `sm`) une fois la V2 validée sur téléphone.
   `SERIES=base,neo,... bash tools/build-packs/run.sh` — le script reprend et reconstruit
   l'index global avec tout.
5. **Worker Cloudflare optionnel** (`tools/build-packs/worker-orb.js`) : regroupe les ~18
   blobs d'un scan en une requête. Non déployé. Si déployé, mettre son URL dans
   `WORKER_ORB` en tête de `scan-v2.js`. Instructions de déploiement dans le fichier.

## R2 (stockage de l'index V2)

- Bucket **`pokescan-packs`**, compte Cloudflare de Nikos.
  Account ID `8a7457771cfa724d62c8fd4fb97dbaf9`.
  URL publique `https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev`.
- CORS posé (dashboard) pour `poke-scan-drab.vercel.app` + `http://localhost:8802`.
- Objets : `index-global.bin`, `index-global-meta.json.gz`, `pack-<set>.pack` (un par set,
  format navigateur), `orb/<clé>.orb` (par carte), `manifest.json`, `status.json`.
- Clés d'écriture : `tools/build-packs/.env` (non commité, à recréer après révocation).
- `api/pack.js` (gist, pas R2) sert encore `scanner-test.html` — ne pas y toucher.

## Outils de build — `tools/build-packs/`

```bash
cd tools/build-packs
npm i --include=optional --os=win32 --cpu=x64     # voir pièges ci-dessous
# .env :  R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=pokescan-packs
SERIES=swsh,sv,me bash run.sh                     # build une tranche, reprend après crash
```

- `index.mjs` — construit embeddings + ORB + dHash (format navigateur exact), envoie packs
  + blobs + `index-global.bin` + `manifest.json` sur R2, écrit `status.json` en continu.
- `run.sh` — boucle de relance. `lib.mjs` — fonctions partagées.
- `split-orb.mjs` — redécoupe des packs R2 existants en blobs `orb/<clé>.orb` (le builder le
  fait maintenant tout seul ; utile seulement pour rattraper d'anciens packs).
- `verify-orb.mjs` / `verify-global.mjs` — tests de fidélité (Node↔navigateur : embeddings
  207/207, ORB self=700 ; recall shortlist 100 % top-30).
- **`build.html`** (racine, déployé) — tableau de bord live lisant `status.json`.
  **`api/build-control.js`** — relancer/passer/tout reprendre/stopper depuis la page.
- Build complet ~2 h pour 7 591 cartes (~585 ms/carte).

### Pièges d'install (machine de Nikos, Windows)

- **`onnxruntime-node` 1.21 crashe au chargement DLL** → forcé en **1.20.1** via
  `"overrides"` dans `tools/build-packs/package.json`.
- **`sharp` 0.35 ne charge pas** → **0.34.5**, avec `npm i --include=optional --os=win32
  --cpu=x64`.
- **transformers.js WebGPU** : `dtype:'fp16'` exige la fonctionnalité `shader-f16`, absente
  de beaucoup de GPU mobiles → toujours prévoir `webgpu/fp32` en repli avant WASM.

## Tester la V2 en local

```bash
npx serve -l 8802 .
```
(ou l'outil `preview_start` name `pokescan` — `.claude/launch.json` existe déjà.)

Puis `http://localhost:8802/index.html?v2`. Dans la console :

```js
await window.SCAN_V2.initV2({onProgress:(p,m)=>console.log(m)});
window.SCAN_V2.moteurV2();  window.SCAN_V2.diagV2();   // quel moteur, pourquoi
// tester sur une vraie photo (redressement réel de l'app) :
const dew = await window.redresserPhotoImportee('/photos-test/PKMN-151-001-03434.jpg');
await window.SCAN_V2.identifierV2(dew);
```

- `photos-test/` : 31 vraies photos (set 151), servies en même origine. Les cartes y sont
  en paysage → `redresserPhotoImportee` fait le redressement comme l'app.
- Les images `assets.tcgdex.net` **n'ont pas de CORS** : impossible de les dessiner sur un
  canvas cross-origin. Passer par `photos-test/` ou par le redressement.
- Le navigateur intégré a un **WebGPU logiciel** (lent) — pas représentatif pour le temps
  d'embedding ; sur GPU réel c'est ~2-3× plus rapide.

## Lire les logs de scan (retours téléphone)

Naviguer le navigateur intégré sur le domaine Vercel (le fetch same-origin marche ;
cross-origin depuis localhost échoue) :

- `https://poke-scan-drab.vercel.app/api/scan-log?format=json` → `{count, resume, entries}`.
  Par entrée : `predit`, `categorie`, `fiabilite`, `inliers`, `marge`, `ms`,
  `T:{emb,refs,orb,ocr}`, `moteur`, `diag`, `packTelecharge`, `sets`.
- `?format=clear` pour vider avant une session de test.
- **`predit` == `attendu` == `cardId` dans le log** (tous mis à la prédiction) : le log ne
  mesure PAS la justesse tout seul. Il faut que Nikos corrige les cartes fausses (→
  `verifie:true`) ou qu'il dise ce qui a raté.

## Réglages clés de `scan-v2.js`

- `SHORT = 18` — largeur de shortlist embedding.
- `INLIERS_MIN = 10` — sous ce seuil sans OCR concordant → `rebut` (on ne devine pas).
- `geoFranche = inl >= 20 && dom >= 0.6` → `sure` même si la sigmoïde est basse.
- `MAX_CARTES_ORB = 900` — descripteurs gardés en mémoire du worker (LRU).
- `noterPickV2()` — 3 scans du même set → charge le pack entier en fond (« mode classeur »).
- `WORKER_ORB = null` — mettre l'URL du Worker si déployé.
