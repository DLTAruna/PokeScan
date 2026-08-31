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

## Le banc V2 — `bench-v2.html`

**C'est l'outil à ouvrir avant de régler quoi que ce soit.** Il importe le vrai
`scan-v2.js` (jamais une copie) et passe les 31 photos réelles de `photos-test/`,
redressées comme le fait l'application. `photos-test/liste.json` porte la vérité terrain
— ajouter une photo demande d'ajouter sa ligne, le banc ne devine pas le contenu du
dossier.

**⚠️ `photos-test/` est exclu du dépôt** (`.gitignore` : photos personnelles et
volumineuses) — le corpus n'existe donc QUE sur le poste de Nikos, jamais sur le site
déployé. Son bouton s'y désactive tout seul ; **caméra et catalogue n'en dépendent pas** et
restent disponibles partout. `photos-test/liste.json` (la vérité terrain) est dans le même
cas : local uniquement, à recréer si le dépôt est recloné — le mappage est trivial,
`PKMN-151-<n°>` → `sv03.5-<n°>`.

**Passe de référence (réglages d'usine) : 25/31 justes, 23/24 des « sûres ».** Ces
chiffres viennent de l'application elle-même : si le banc en donne d'autres à réglages
égaux, c'est SON redressement qui a dérivé (le seul bloc qu'il duplique), pas la chaîne.

Pilotage console — c'est ainsi qu'on s'en sert vraiment, par paquets pour ne pas dépasser
le délai d'attente d'un outil :

```js
await BANC.init()                  // index + corpus ; renvoie moteur, tranche, warm1/warm2
BANC.config({SHORT:30})            // réglages de scan-v2.js (voir reglagesV2)
BANC.degrader({flou:1.5})          // dégrade l'image de requête (flou px, reduc ×, jpeg q)
await BANC.froid({disque:true})    // vide les caches ORB — vrai démarrage à froid
await BANC.lancer(10)              // 10 photos ; répéter jusqu'à 31/31
BANC.cloturer('Worker OFF')        // fige la passe et l'ajoute au tableau comparatif
BANC.passes()                      // comparer les passes entre elles
```

`reglagesV2(patch)` (dans `scan-v2.js`) expose SHORT, TIEBREAK, INLIERS_MIN,
OCR_INLIERS_MIN, OCR_DOM_MAX, GEO_*, RECYCLE_ORB, MAX_CARTES_ORB, WORKER_ORB.
`viderCachesV2({memoire, disque})` vide le cache ORB. La production n'appelle ni l'un ni
l'autre.

`T.refsDetail` ventile `refs` en `{idb, net, imp, nManque, nReseau, viaWorker}`.
**Piège de lecture** : sans Worker, les téléchargements par carte tombent dans `imp`, pas
dans `net` — un `net` à 0 veut dire « Worker désactivé », pas « aucun réseau ». Regarder
`viaWorker`.

### Mode caméra — scanner de vraies cartes depuis le téléphone

Ouvrir `https://poke-scan-drab.vercel.app/bench-v2.html` sur le téléphone (HTTPS exigé par
la caméra), « Charger l'index », puis « Ouvrir la caméra ». Même chaîne que le corpus,
même déclenchement que l'application (score franc, 2 images immobiles, verrou jusqu'au
retrait).

**Chaque carte lue demande un verdict** — c'est le point. Les journaux de l'application
comparent `predit` à `attendu` alors que les deux valent la prédiction : ils annoncent donc
100 % quoi qu'il arrive. Ici, « ✓ C'est la bonne » / « ✕ Fausse » / choisir la vraie carte
parmi les alternatives. Le verdict ne bloque pas la caméra : on peut enchaîner et revenir.

- **Tout est conservé sur l'appareil** (IndexedDB `banc_v2`) et **survit à un
  rechargement** — une session se fait debout, carte en main, un rechargement accidentel
  ne doit pas effacer une demi-heure de verdicts.
- **Chaque scan porte l'état de l'appareil** : charge de la batterie et étalon de vitesse
  (`etalonV2` — même embedding sur la même image, ~300 ms sur un poste correct). Ajouté
  après une session entière perdue à 6 % de batterie, où emb/refs/orb avaient tous triplé
  sans qu'on puisse distinguer un code lent d'un téléphone bridé. Le banc prévient
  désormais sous 20 %.
- **`☁ Envoyer les scans`** remonte tout vers `/api/scan-log` (`outil:'banc-v2'`, ~580
  octets par scan, **sans les photos**) — lisible ensuite depuis un poste, avec un taux de
  justesse enfin réel. `⭳ Exporter` donne un JSON complet, photos comprises.

### Mode CATALOGUE — tirer au hasard dans toute la tranche

`BANC.preparer({n:50, graine:7, series:['sv','swsh']})` puis `await BANC.catalogue(25)`.
Tire un échantillon **reproductible** (même graine = même échantillon) parmi les 7 591
cartes, télécharge l'illustration officielle (`/high.webp`, la source même du constructeur
de packs) et la passe dans la chaîne.

**⚠️ XY et SM ne sont PAS dans l'index** (tranche = swsh + sv + me, soit 2020→aujourd'hui).
Les tester ne produirait que des rebuts. Il faut d'abord étendre la tranche (§ « Ce qui
reste », point 3).

**⚠️ À dégradation nulle c'est un auto-appariement** — l'index a été construit sur ces
images-là. Le 80/80 obtenu ne prouve rien sur la reconnaissance : c'est un contrôle
d'intégrité de l'index et un étalon de vitesse. **Tout l'intérêt est dans la dégradation.**

### Ce que le banc a déjà répondu (2026-08-31)

- **Worker Cloudflare** : `refs` 212 ms (203 réseau + 9 cpu) contre 266 ms sans lui, à
  disque froid. ~20 % sur connexion filaire — l'intérêt reste le mobile, où chaque
  connexion coûte, et cela reste à mesurer là-bas.
- **Sensibilité au flou** (la question ouverte après le retrait de `meilleureDeDeuxImages`) :

  | flou | justes | sûres justes | rebuts |
  |---|---|---|---|
  | 0 | 25/31 | 23/24 | 4 |
  | 1,5 px | 24/31 | 22/23 | 6 |
  | 3 px | 24/31 | 12/13 | **16** |

  **Le flou ne rend pas la V2 fausse, il la rend muette.** La justesse tient (24-25/31) et
  les « sûres » restent justes à ~95 % — mais les rebuts quadruplent. Or un rebut coûte un
  cycle de re-scan entier (~2 s), bien plus que les ~150 ms qu'économisait le retrait du
  choix entre deux images. **Le taux de rebut est donc la métrique à surveiller sur
  téléphone** ; s'il dépasse nettement les ~13 % du banc à image nette, c'est que la
  capture arrive floue et qu'il faut remettre la sélection.

### Campagne catalogue (80 puis 50 cartes tirées au hasard, 34 sets, 2026-08-31)

**Image parfaite : 80/80** (contrôle d'intégrité — auto-appariement, voir l'avertissement
plus haut). Fait notable au passage : **10 cartes sur 80 déclenchent l'OCR même en image
parfaite**, c'est-à-dire ont une quasi-jumelle visuelle dans le catalogue. La chaîne les
départage correctement.

**Profil « photo réaliste »** (flou 1,5 · réduc 0,5 · jpeg 0,7 · rotation 1,5° · lumière
0,85) : **45/50 justes, et 45/45 des « sûres » justes.** Les 5 échecs sont tous
correctement rangés en douteuse ou rebut. **La séparation est béante** : la plus faible
« sûre » a **45 inliers**, les échecs en ont 5, 6 et 10. Un cas instructif : 72 inliers
mais 3 de marge (une jumelle juste derrière) → correctement jugé douteux par le critère de
dominance.

**La falaise flou × réduction.** Pris séparément, aucun facteur ne gêne (réduc 0,4 seule :
25/25, inliers médians 184 ; rotation 3° seule : 25/25, médiane 226 ; flou 3 seul : 25/25,
médiane 65). **C'est leur combinaison qui tue** — un passe-bas composé qui efface la texture
dont l'ORB vit :

| réduc \ flou | 1,5 px | 3 px |
|---|---|---|
| 1,0 | 25/25 · 0 rebut | 25/25 · 0 rebut · inl 65 |
| 0,7 | 15/16 · 0 rebut · inl 93 | 12/16 · 4 rebuts · inl 28 |
| 0,55 | 15/16 · 1 rebut · inl 69 | 10/16 · 6 rebuts · **inl 12** |
| 0,4 | 21/25 · 2 rebuts | **0 exploitable · inl 0** |

**Précision des « sûres » : 100 % dans TOUTES les cases.** La chaîne ne ment jamais, elle
se tait. Et **`inliers` médian est l'indicateur de santé de la capture** : à l'aise
au-dessus de ~50, sur le fil vers 15-20, aveugle à 0. Il est affiché dans le résumé du mode
caméra — s'il s'effondre sur téléphone, c'est la PHOTO qu'il faut soigner, pas les seuils.

**Repli sur l'embedding quand l'ORB est aveugle : mesuré, puis ABANDONNÉ.** L'idée était de
sauver les cas à 0 inlier en gardant le premier de la shortlist embedding. Mesure sur les
19 cas aveugles d'une passe : l'embedding seul n'a raison que **6 fois sur 19 (32 %)**.
Faire relire 19 cartes pour en sauver 6, en réintroduisant la devinette que `INLIERS_MIN`
avait justement supprimée, n'en vaut pas la peine. `res.embPremier` reste exposé pour
pouvoir refaire la mesure.

### Banc de DÉTECTION — « je vois la carte mais ça ne déclenche pas » (V.9)

`BANC.detection(10)` fabrique 260 scènes à partir des illustrations de l'API (fond,
échelle, inclinaison, décentrage, bord coupé, lumière, flou) avec la position vraie connue,
et mesure ce que le détecteur scanic en dit. **Verdict : un seul facteur compte, la TAILLE
de la carte dans le cadre.**

| taille (hauteur/cadre) | aire | vue (≥0,35) | déclenche (≥0,5) |
|---|---|---|---|
| 0,85–0,95 | 0,33-0,40 | 100 % | 100 % |
| 0,72 (référence) | 0,278 | 100 % | 100 % |
| 0,55 | 0,16 | 100 % | 90 % |
| **0,40** | **0,086** | **60 %** | **60 %** |
| **0,30** | **0,048** | **10 %** | **10 %** |

**Tout le reste est indifférent** : lumière ×0,35 à ×1,5 → 100 % ; flou jusqu'à 5 px →
100 % ; inclinaison jusqu'à 90° → 100 % ; décentrage jusqu'à 0,22 → 100 %. Fonds sombre ou
encombré : 90 %.

**C'est l'explication de la frustration** — l'utilisateur voit parfaitement sa carte à
l'écran, mais si elle n'occupe que 8 % de l'image le détecteur est aveugle une fois sur
deux. **Et cela relie le problème d'objectif** : un ultra grand-angle à 0,6× fait passer une
carte de 28 % à ~10 % du cadre, c'est-à-dire du confort à la zone de panne. **Régler le zoom
sur l'objectif principal est donc la première chose à faire**, avant tout réglage de seuil.

Conséquences posées dans le code (`AIRE_LIMITE_V2 = 0.08`, `AIRE_CONFORT_V2 = 0.15`, calées
sur ces mesures) : l'indice dit « Rapproche la carte — elle doit remplir le cadre » quand
rien n'est vu depuis 2,5 s, et « elle est trop petite dans le cadre » quand elle est vue
mais sous le seuil. Avant, « Vise la carte » envoyait corriger un cadrage qui n'était pas en
cause. Le banc affiche la part du cadre en direct (`cadre 27 %`).

### Banc de DÉCLENCHEMENT — le délai avant capture (V.10)

`BANC.apercu()` montre les séquences en images ; `BANC.declenchement(n)` fait concourir des
politiques de déclenchement sur les MÊMES séquences simulées (posée lentement, posée vite,
main tremblante, arrivée de côté, tenue loin), image par image, avec flou de bougé
proportionnel au déplacement. `BANC.politiques([...])` permet d'en essayer d'autres.

Chaque politique est jugée sur le **temps total par carte** = attente + identification
(1,2 s) + prix des reprises (une capture inexploitable coûte ~2,7 s).

| Politique | délai médian | identifiable | total |
|---|---|---|---|
| immédiate (score ≥ 0,5, aucune stabilité) | 0 ms | **25 %** | 3 225 ms |
| 2 images stables @0,049 (ancienne) | 768 ms | 100 % | 1 968 ms |
| **1 image stable @0,030 (retenue)** | **576 ms** | **100 %** | **1 776 ms** |
| 1 image stable @0,020 | 960 ms | 100 % | 2 160 ms |
| 2 images stables @0,030 | 1 152 ms | 100 % | 2 352 ms |

**Conclusions appliquées :**
- **Une seule image immobile suffit** — la deuxième ne prouvait rien de plus et coûtait
  192 ms sur chaque carte. `V2_BOUGE_BASE` resserré à **0,030** (au lieu de 0,049) : gratuit
  en temps, et c'est lui qui remplace la seconde image comme garde-fou contre une carte en
  transit.
- **Ne rien exiger s'effondre à 25 %** : on capture la carte en vol, floue. Une preuve
  d'immobilité reste indispensable — c'est le point d'équilibre, pas un excès de prudence.
- **L'aire NE DOIT PAS être un verrou** : la politique « aire ≥ 15 % » ne déclenchait jamais
  sur les cartes tenues loin (4 séquences sur 20 jamais capturées). Elle reste un CONSEIL
  affiché, jamais une condition.

### Optimisation des paramètres : rien à changer, et c'est un résultat

- **`SHORT = 18` confirmé.** À 30 : justesse identique (21/25 dans les deux cas) pour
  **+58 % de temps** (836 ms contre 528). Élargir la shortlist n'achète rien.
- **Seuils confirmés bien placés.** Au profil réaliste, la précision des « sûres » est de
  100 % et l'écart entre la plus faible « sûre » (45 inliers) et le plus fort échec (10)
  est d'un facteur 4,5. Les échecs ne sont pas des cas limites qu'un seuil rattraperait :
  ce sont de vrais échecs de l'ORB. Y toucher ne ferait qu'abîmer la précision.
- **Seule correction retenue** : le message de rebut ne disait que « recentre la carte »,
  un contresens quand la carte est déjà centrée et que le problème est le flou ou la
  distance. Il se différencie désormais sur les inliers (≤ 2 → « rapproche-toi et tiens la
  carte immobile » ; au-dessus → « peut-être hors catalogue »).

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

- **PATIENCE (V.8)** — le déclenchement était un ET strict à seuils fixes, et il demandait
  à la main de se figer. Mesuré au banc : seuil de stabilité 0,049, main qui tremble 0,054
  → une image sur deux dépassait, la série de deux images concordantes ne se refermait
  **jamais**. On pouvait tenir une carte lisible plusieurs secondes sans rien déclencher.
  Les seuils se desserrent désormais avec la durée de présence (`v2PresentDepuis`) :
  à 1,2 s tolérance au mouvement ×3 et score au minimum ; à 2,5 s une seule image suffit,
  quel que soit le bougé. **Valeurs de départ inchangées** — une carte posée nette part
  toujours aussi vite. **Le verrou « déjà lue » ne se desserre PAS** (il relirait en boucle
  la carte qu'on tient). Même logique dans `bench-v2.html`, qui affiche les trois verrous
  en direct (`#c-jauges`) — c'est ce qui a permis de lire 0,054 contre 0,049 au lieu de le
  supposer.
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
