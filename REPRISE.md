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

## « Vérification approfondie » : la première idée s'affiche pendant le départage (V.20)

Idée de Nikos : « en cas de besoin OCR, indiquer *vérification approfondie*, traiter à part,
et afficher d'abord la 1ʳᵉ idée dans le cadre sous l'appareil photo. »

C'est le principe de l'accusé de réception (V.15) descendu d'un cran. Quand l'ORB hésite
entre deux cartes, il passe la main à l'OCR du numéro : 0,3 à 3,2 s pendant lesquelles le
cadre du bas ne montrait rien. Or **l'ORB a déjà un favori à cet instant** — il est seulement
trop serré pour qu'on s'y fie seul. Autant le montrer.

- **`identifierV2(carte, opts)`** accepte désormais `opts.onProvisoire(avis)`, appelé
  uniquement quand l'OCR va partir, juste avant, avec le meilleur candidat courant.
- **`gererScanV2`** l'affiche aussitôt : nom, set, numéro, badge 🔍, ligne « vérification
  approfondie… » en ambre, et un liseré ambre qui respire autour du cadre.
- **⚠️ Cet avis ne sert QU'À L'AFFICHAGE.** Rien ne s'enregistre à partir de lui : la file,
  le classeur, le stock et le journal attendent tous `res`, la seule vérité. C'est ce qui
  rend le procédé sûr même quand l'OCR change d'avis.
- Piège d'ordre, corrigé : `showLiveResultDone` repose le badge, donc la marque de
  vérification doit être appliquée APRÈS, sinon son 🔍 est écrasé.

**Vérifié** (`PKMN-151-009`, vrai cas de départage) : première idée à t+0, résultat définitif
**1 024 ms plus tard**, même carte, fiabilité 75 %. Sur le cas du téléphone (`me02-123`,
3 226 ms d'OCR), le nom apparaîtrait donc plus de trois secondes plus tôt.

## 🔬 CAMPAGNE DE MESURE 31 CARTES + OPTIMISATIONS (V.19, 2026-09-01)

Demande de Nikos : mesurer par lot de 30 sur cartes réelles en simulant l'appareil photo,
chiffrer les délais, optimiser capture ET affichage.

### ⚠️ D'ABORD : CE QUI N'EST PAS MESURABLE DANS LE VOLET NAVIGATEUR

**Quand le volet est masqué, `visibilityState` vaut `hidden` et Chrome plafonne `setTimeout`
à 1 000 ms.** Mesuré : minuteurs de 10 / 50 / 100 / 250 / 500 ms → tous revenus à ~1 000 ms.
La boucle `detectLoop` étant cadencée par `setTimeout`, elle tombe à **1,3 Hz au lieu de
~10 Hz** (inférence réelle : 51 ms ; intervalle entre deux tours : 1 000 ms).

**Conséquence : toute mesure de DÉLAI DE DÉCLENCHEMENT y est fausse.** Les valeurs sont
passées de 292 ms à 3 050 ms sans qu'une ligne de code change — seul le volet s'était masqué.
**Piège dans le piège** : un contrôle de fidélité fait avec un `setTimeout(1000)` répond
« fidèle » — 1 000 ms est précisément le plancher du bridage. **Toujours contrôler avec un
minuteur COURT (50-100 ms).**

Restent valides et mesurables ici : justesse, rebuts, catégories, et la durée de la chaîne
d'identification (enchaînée en promesses et workers, pas en `setTimeout`).
**Le délai de déclenchement se mesure sur le téléphone, via `/api/scan-log`.**

### Trois pièges de banc, corrigés (à ne pas refaire)

1. **Décalage d'un cran.** La fiche complète de la carte PRÉCÉDENTE arrive ~1 s après sa
   capture et rappelle `showLiveResultDone` ; la sonde la prenait pour le résultat courant.
   Toute la salve semblait fausse (1/15) alors que l'application était juste. → n'accepter un
   résultat qu'après le début de l'identification en cours (`M.tGerer`).
2. **Salves concurrentes.** Un appel d'outil qui expire laisse sa boucle tourner DANS la page.
   La salve suivante démarrait par-dessus : deux boucles pilotant la même caméra. → jeton de
   génération vérifié à chaque étape.
3. **Cache ORB qui se réchauffe** d'une salve à l'autre : la dernière configuration testée
   paraissait la plus rapide. → `viderCachesV2({memoire:true})` avant chaque mesure.

### Résultat : SHORT reste à 18, et c'est un résultat

Protocole identique, cache mémoire vidé avant chaque salve, 31 photos réelles :

| SHORT | justes | sûres justes | rebuts | ms méd | ms p90 |
|---|---|---|---|---|---|
| 12 | 23 | 21/22 | 7 | 560 | 607 |
| **18 (retenu)** | 23 | 21/23 | 6 | 627 | 813 |
| 30 | 24 | 22/23 | 5 | 753 | 1074 |

Un rebut coûte un re-scan complet (~2,5 s), soit ~81 ms/carte amortis sur 31. Les trois
réglages se tiennent donc à ±45 ms d'espérance : **aucun ne domine, on ne touche à rien.**
⚠️ Ceci CORRIGE la note antérieure « SHORT=30 n'achète rien, +58 % de temps » : sur l'index à
18 646 cartes, 30 rattrape bien une carte et un rebut — mais le gain reste dans le bruit.

### Optimisation retenue : l'OCR de départage ne doit pas se déclencher sur un écart franc

`dominance = marge / inl` est un RATIO, et un ratio confond deux situations opposées :

| cas | inliers | marge | dominance | OCR utile ? |
|---|---|---|---|---|
| vraie égalité | 35 contre 15 | 20 | 0,57 | **oui** |
| écart décisif | 93 contre 39 | 54 | 0,58 | **non** |

Les deux passaient le test. Le second est réel : `me02-123` sur le téléphone, **98 % de
fiabilité, verdict juste, et 3 226 ms d'OCR pour confirmer l'acquis** — le pire pic de la
salve. Et il est devenu PLUS fréquent depuis qu'on a accéléré l'ORB, car le garde-fou
thermique (`OCR_ORB_MS_MAX`) ne se déclenche plus.

**Ajouté : `OCR_MARGE_MAX = 35`** — l'OCR exige désormais un coude-à-coude *en valeur
absolue* aussi. Seuil calé pour préserver les deux seuls cas où l'OCR a jamais changé un
verdict (marges 20 et 0).

**Vérifié sur les 31 photos** : justesse, sûres et rebuts **identiques** avant/après (24
justes, 23 sûres dont 22 justes, 5 rebuts à SHORT=30), et **aucun** des départages légitimes
du corpus n'est sauté — les deux OCR restants ont des marges de 19 et 6, ce sont de vraies
égalités. La correction ne mord que sur le cas du téléphone.

## Écran de chargement du scanner (V.18, 2026-09-01)

Demande de Nikos : « on peut mettre un loading screen le temps de charger le scanner, avec
des animations modernes ? » — pertinent depuis que le catalogue pèse 6,8 Mo.

**D'abord rendre la progression honnête.** `initV2` sautait de 5 % à 55 % : ce trou EST le
téléchargement du gros fichier. Une barre y serait restée figée pendant tout ce qui compte.
`telechargerR2` accepte donc `onOctets(recus, total)` et lit le corps **en flux**
(`response.body.getReader()`) quand l'appelant veut suivre ; l'index rapporte alors son
avancement réel, converti en 0,05 → 0,50, avec les mégaoctets affichés.

**Contrainte de conception, notée dans le CSS** : pendant la phase « Décodage », le fil
principal décode 6,8 Mo d'empreintes et reste bloqué plusieurs secondes. Toute animation
pilotée par JS, ou touchant à la mise en page (`width`, `top`), se figerait **précisément à
ce moment-là** — quand l'utilisateur se demande si ça marche encore. On n'anime donc que
`transform` et `opacity`, traités par le compositeur sur son propre fil. La barre suit la
même règle : `scaleX`, jamais `width`.

Contenu : silhouette de carte (le sujet de l'attente, plutôt qu'un rond qui tourne) balayée
par un faisceau, titre, étape en clair, barre, et une note qui n'apparaît que pendant le
téléchargement pour dire qu'il ne se reproduira pas. Placé sous la croix de sortie
(z-index 15 contre 20) : on doit pouvoir refermer la caméra même pendant le chargement.
`prefers-reduced-motion` immobilise tout sauf la barre.

⚠️ **Défaut trouvé au test, corrigé** : un fondu de sortie programmé (`setTimeout` 320 ms)
pouvait recacher l'écran juste après un réaffichage. Le minuteur est désormais gardé et
annulé par `afficherLoaderV2`, qui plafonne aussi l'avancement rejoué à 0,99 — rejouer un
« 100 % » mémorisé relançait le masquage aussitôt.

**Non vérifié ici** : que les animations *bougent*. Le volet navigateur gèle rAF (voir la
correction en tête de la section V.17). Mise en page, textes, valeurs de la barre et
séquence afficher/masquer sont vérifiés ; le mouvement ne l'est que sur appareil réel.

## 🗂️ CATALOGUE COMPLET EN LIGNE — 18 646 cartes (build terminé le 2026-09-01, 12h33)

Le build de fond lancé dans la journée s'est terminé : **185/185 sets, 18 646 cartes, 4 h 17**.
Poussé sur R2 et **déjà en production** (le manifeste est lu à chaque `initV2`).

- **Tranche : les 18 séries**, `base+misc+neo+ecard+ex+pop+tk+dp+pl+hgss+col+bw+mc+xy+sm+swsh+sv+me`
  — soit **1999 → aujourd'hui**. XY et SM sont désormais dedans (ils n'y étaient pas).
- `index-global.bin` passe de ~3 Mo à **6,8 Mo** ; `manifest.sets` compte **142 sets** (les
  185 incluent ceux à 0 carte exploitable, qui ne produisent pas de pack).
- **Invalidation du cache vérifiée** : la clé est `idx:<manifest.updatedAt>` et `updatedAt`
  a changé (`2026-09-01T12:33:31.013Z`), donc `idbDelPrefixe` efface l'ancien index et le
  nouveau se télécharge. Rien à faire à la main.
- Restent **irrécupérables** (0 carte, ni FR ni EN) : `sm3.5`, `sm7.5`, `cel25cc`, `sve`,
  `mee`, plus les `tk`/`mc` déjà connus.

**⚠️ Trois conséquences à surveiller au prochain test téléphone :**
1. **Premier scan de session : 6,8 Mo à télécharger** (une seule fois, puis IndexedDB).
2. **La shortlist cherche dans 2,5× plus de cartes** (18 646 contre 7 591) : le temps de
   recherche d'empreintes (compris dans `T.emb`) va monter.
3. **Plus de quasi-jumelles visuelles ⇒ plus d'OCR de départage**, donc le pic à 3,2 s
   décrit juste en dessous risque de devenir plus fréquent, pas moins. C'est l'argument le
   plus fort pour trancher la question laissée ouverte (sauter l'OCR à inliers très élevés).

Les chiffres « 7 591 cartes » qui subsistent plus bas dans ce fichier décrivent l'ANCIENNE
tranche : ils restent justes pour les campagnes de banc déjà menées, pas pour l'index actuel.

## ⭐ LE BUG D'INTERFACE : UN ANCÊTRE TRANSFORMÉ (V.17, 2026-09-01)

**À connaître avant de toucher au plein écran.** Nikos : « on dirait que l'interface bug,
remonte le cadre de visée ». Les deux constats n'en faisaient qu'un.

Un élément `position:fixed` se résout contre le **viewport** — *sauf* si un ancêtre porte un
`transform`, `filter` ou `perspective` : cet ancêtre devient alors le bloc conteneur. Or
`#section-capture` reçoit l'animation d'entrée d'onglet
(`section.section.active{animation:ongletEntre .26s}`), qui pose un `transform` le temps de
se jouer.

Conséquence mesurée : la zone caméra, pourtant `inset:0`, se dessinait à **148 px du haut sur
284 px de haut** au lieu des 812 px de l'écran. Tout ce qui se cale dessus — cadre de visée,
voile sombre, panneau de résultat — héritait donc d'une boîte fausse.

**⚠️ CORRECTION HONNÊTE (V.18) — la première rédaction de cette section était fautive.**
Elle affirmait que l'animation « restait bloquée » (`currentTime: 0`, état `running`).
C'était un **artefact de l'environnement de test** : dans le volet navigateur intégré,
quand il est masqué, `requestAnimationFrame` **ne se déclenche pas du tout** (vérifié : une
boucle rAF de 500 ms n'a jamais rendu la main en 45 s), donc animations et transitions sont
gelées. Sur un vrai appareil, `ongletEntre` se termine en 260 ms et le `transform` redevient
`none`.

**Le problème n'en reste pas moins réel, mais pour une autre raison** : `startCamera()`
appelle `majCadrageVisible()` immédiatement après avoir posé `.fs`, c'est-à-dire **pendant**
ces 260 ms d'animation. La géométrie (`cadrageVisible`, `decalageGuideY`, `hauteurLibreGuide`)
est donc mesurée contre la boîte piégée, **puis mise en cache** — elle n'est recalculée qu'au
redimensionnement, à la rotation, ou après la première carte. Le cadre de visée est donc
faux jusqu'à la première capture. La correction ci-dessous reste donc la bonne, et vaut
aussi garde-fou : plus aucun ancêtre transformé pendant que la caméra est ouverte.

**Leçon d'outillage à retenir** : dans ce volet, on peut vérifier la MISE EN PAGE (les
captures d'écran forcent un rendu) et les valeurs de style en ligne, mais **jamais qu'une
animation ou une transition se déroule**. Ne rien conclure d'un `currentTime` ou d'un
`getComputedStyle` sur une propriété en cours de transition — les deux mentent ici.

**Corrigé** : `body.cam-plein section.section{animation:none !important; transform:none
!important;}`, la classe étant posée à l'ouverture de la caméra et retirée à sa fermeture.
Vérifié : `transform: none`, zone caméra `0 → 812`, plein écran exact.

### Cadre de visée remonté, et surtout borné

Le décalage vertical était à 0 depuis la V.13 (ses deux repères, barre du haut et
déclencheur, avaient été retirés) : le cadre se centrait donc sur l'IMAGE, et son bas passait
**derrière** le panneau de résultat — devenu plus haut encore avec la ligne Fiabilité. Il se
recentre désormais sur la place réellement libre, **mesurée sur ce qui existe** : du bas de
la croix de sortie au haut du panneau. Et `guideRect` reçoit une **troisième borne**
(`hauteurLibreGuide`) pour que le cadre TIENNE dans cette place — sans elle, le remonter ne
faisait que déplacer le débordement. Vérifié : 72 px de marge en haut comme en bas.

### Animations : ce qui sautait encore

La position des coins était déjà lissée (exponentielle en temps + extrapolation à l'estime).
Deux choses sautaient encore, et ce sont elles qui se lisaient comme une hésitation :

- **La couleur d'état** (rouge → ambre → vert) changeait d'un bloc, souvent deux fois par
  seconde sur une main qui bouge : ça clignotait. Elle est maintenant interpolée
  (`COULEUR_TAU_MS = 130`, volontairement plus lent que les 40 ms du suivi de position — une
  couleur qui rattrape aussi vite que la géométrie redevient un clignotement).
- **La présence du contour** : il apparaissait et disparaissait sèchement à chaque décrochage
  du détecteur, alors que la carte, elle, est toujours là. Fondu (`PRESENCE_TAU_MS = 90`).

⚠️ **Piège** : la condition `change` de `renderOverlayLoop` doit inclure ces deux animations
(`couleurBouge`, delta de `presenceContour`), sinon une transition se **fige à mi-chemin** dès
que la carte est immobile — c'est-à-dire précisément le cas qu'on attend. Les deux convergent
(seuils d'arrêt 0,4 et 0,002), donc aucun redessin perpétuel.

### Résultats V.16 — la correction de concurrence est confirmée

7 scans, **tous `sure`**, fiabilité 85 à 99 %.

| | V.14 | V.16 |
|---|---|---|
| `orb` | 1 407 · 2 612 · 1 986 (**dérive**) | 575 · 891 · 862 · 910 · 770 · 905 · 926 (**plat**) |
| total médian | 3 676 ms | **2 344 ms** |

**`T.orb` ne dérive plus** : il reste à ~900 ms sur sept scans au lieu de doubler. La dérive
attribuée au throttle thermique était donc bien, pour l'essentiel, **fabriquée** par les
inférences du détecteur pendant l'identification.

**Nouveau poste dominant : `refs`** (537-1223 ms, dont 374-1075 de réseau, 8 à 18
descripteurs par carte). C'est désormais là qu'il faut chercher.

**Et un piège nouveau** : la carte `me02-123` a coûté **5 377 ms dont 3 226 d'OCR**, alors
qu'elle avait 93 inliers et 98 % de fiabilité — elle n'était pas ambiguë. L'OCR de départage
se lance sur `inl >= 25 && dominance < 0.6` (ici 54/93 ≈ 0,58, juste sous le seuil), et le
garde-fou « session chaude » qui le sautait (`dernierOrbMs >= 1800`) **ne se déclenche plus
maintenant que l'ORB est rapide** : accélérer l'ORB a rendu l'OCR plus fréquent. À traiter —
piste : sauter l'OCR quand les inliers sont très élevés (au banc, il n'a jamais changé un
verdict au-dessus de ~53 inliers).

## ⭐ POURQUOI LE BANC ÉTAIT 2 À 3× PLUS RAPIDE (V.16, 2026-09-01)

Question de Nikos : « le banc de test V2 paraissait beaucoup plus rapide, comment expliquer
ça ? » Le journal permet de comparer, **sur le même téléphone, avec le même module et le
même moteur (`webgpu/fp16`)** :

| | ms par carte |
|---|---|
| banc (`outil:'banc-v2'`) | 1 091 · 1 122 · 1 135 · 1 282 · 1 407 · 1 465 · 1 545 — **médiane ~1 400** |
| application (V.14) | 3 078 · 3 676 · 4 063 |

**La différence n'est pas dans la chaîne d'identification. Elle est dans la boucle.**

Le banc pose `occupeCam = true` pendant toute sa capture et **suspend sa détection** :
```js
if(!v.videoWidth || occupeCam){ await new Promise(r=>setTimeout(r,120)); continue; }
```
L'application, elle, continuait de détecter pendant l'identification. `readInFlight`
n'empêchait que le **déclenchement**, pas la détection : `createImageBitmap` + une inférence
ONNX du détecteur de contours **toutes les ~60 ms**, soit **25 à 50 inférences** pendant les
3,5 s d'identification, à disputer le GPU et le CPU à l'embedding puis à l'ORB.

Et cela **explique aussi la dérive de `T.orb`** au fil d'une salve (1 407 → 2 612 ms sur
trois cartes) : ce n'est pas seulement du throttle thermique subi, c'est du throttle qu'on
fabriquait en faisant tourner le détecteur pour rien.

**Corrigé** : `detectLoop` sort immédiatement tant que `readInFlight` est vrai, exactement
comme le banc. **Vérifié en local : 0 détection pendant l'identification** (compteur posé sur
`detectWorkerCall('detect')`, mesuré entre l'accusé de réception et l'affichage du nom).
Aucun coût d'usage : le déclenchement était de toute façon verrouillé, et Nikos attend le
résultat avant de présenter la carte suivante.

### Fiabilité affichée

Demande de Nikos. Le ✅/🤔 du coin ne disait que « sûre » ou « douteuse » ; le panneau du bas
porte maintenant une ligne **Fiabilité** en pourcentage (`res.fiabilite`, celui-là même qui
part dans le journal), colorée : **vert ≥ 90**, **ambre 70-89**, **rouge < 70**. Repères tirés
des campagnes du banc — aucune erreur jamais observée au-dessus de 90 %.

### Mode « classeur » supprimé (`chargerSetComplet`)

Décision de Nikos sur relevé réel. Au bout de 3 scans du même set, le pack ORB entier
(~5 Mo) était téléchargé en fond. **Le journal montre que ça n'évitait aucun
téléchargement** : trois cartes du même set, et chacune récupère quand même 17-18
descripteurs (`nManque` 18/17/17), parce que la liste `sets` consultés **grossit à chaque
scan** (14 → 21 → 27) — la shortlist est cross-set, les 18 candidats viennent d'une
vingtaine d'extensions différentes. Cinq mégaoctets de données mobiles, en concurrence de
bande passante avec les descripteurs réellement nécessaires, pour un gain nul. Supprimé
(avec `noterPickV2`, `setsComplets`, le suivi `pleinSet` de l'éviction LRU). Le cache par
carte (`orbCharges`, LRU 900) reste — lui sert à chaque scan.

⚠️ Les anciens packs déjà mis en cache (`pack:<setId>` dans IndexedDB `pokescan_v2`) ne sont
plus jamais lus : quelques Mo dorment sur les appareils qui ont tourné avant la V.16. Sans
conséquence fonctionnelle, à balayer un jour si on touche au schéma.

## Fluidité : l'accusé de réception arrivait après l'identification (V.15, 2026-09-01)

Nikos, 4 cartes en V.14 : « il y a un problème de fluidité entre la capture et l'affichage
dans le cadre du bas ». Le journal donne 3 scans (le 4e est un `rejet-doublon`, qui ne
journalise pas — voir plus bas).

**Ce que le journal dit de bon** : identification **parfaite**. 3/3 `sure`, fiabilité 97-98 %,
inliers 63-78, marges 50-64, **aucun OCR déclenché**, moteur `webgpu/fp16`. La chaîne de
reconnaissance n'est pas en cause.

**Ce qu'il dit de mauvais** — le temps, par carte :

| carte | total | emb | refs (dont réseau) | orb |
|---|---|---|---|---|
| sv03.5-027 | 3 078 ms | 586 | 1 085 (905) | 1 407 |
| sv03.5-019 | 4 063 ms | 496 | 955 (549) | **2 612** |
| sv03.5-048 | 3 676 ms | 601 | 1 089 (719) | 1 986 |

**Mais le défaut signalé n'était pas la durée : c'était le silence pendant cette durée.**
Tout le retour à l'utilisateur — vignette, éclair, vibration, cadre vert — était déclenché
dans `gererScanV2` **après** `identifierV2()`, sous un commentaire « 1) TOUT DE SUITE » qui
ne l'était que relativement à l'identification. Vu du téléphone : la carte est présentée,
le cadre passe au vert, **puis plus rien pendant trois à quatre secondes**, puis tout
apparaît d'un coup.

**Corrigé** : `attemptReadV2` acquitte la PRISE dès que l'image redressée existe — vignette
dans le cadre du bas (`showLiveResultPending`, « 🔎 recherche… »), éclair, vibration, cadre
vert. L'identification ne fait plus que remplir le texte. Mesuré en local : vignette à
+0 ms, nom à +956 ms (ce sera +3 à 4 s sur téléphone, mais l'attente est désormais habitée).
La toile et son `dataURL` sont calculés une seule fois et passés à `gererScanV2` — un
`toDataURL` plein format de plus sur le fil principal figeait l'aperçu pour rien.

**Effet de bord traité** : si l'identification revient en `rejet-doublon`, le panneau
resterait bloqué sur « 🔎 recherche… » alors que la carte est connue. `derniereCarteAffichee`
le restaure.

**Pistes de temps, non tranchées** (à décider avec Nikos) :
- **`orb` domine (1,4 à 2,6 s) et dérive** au fil de la salve — déjà identifié comme du
  throttle thermique, pas de la fragmentation (§ « Ce qui reste »).
- **Chaque carte télécharge 17-18 descripteurs ORB** (`nManque` 17-18, `nReseau` 17-18),
  soit 550 à 900 ms de réseau par carte, malgré `packTelecharge:true`. Et la liste `sets`
  du journal **grossit à chaque scan** (14 → 21 → 27 sets) : la shortlist est bel et bien
  cross-set. C'est la confirmation chiffrée du soupçon déjà noté sur `chargerSetComplet()` —
  il télécharge ~5 Mo du set dominant en fond **sans réduire les 17-18 descripteurs
  manquants**, puisque ceux-ci viennent des AUTRES sets. Candidat sérieux à la suppression.

## ⭐ LA CAUSE RÉELLE, TROUVÉE PAR LE JOURNAL (V.14, 2026-09-01)

**À lire avant tout le reste.** Deux corrections à l'aveugle (V.12, V.13) n'ont rien réglé
sur le téléphone de Nikos. La troisième fois, au lieu de deviner, on a lu
`/api/scan-log?format=json` :

| version | scans enregistrés |
|---|---|
| V.11 | oui — dernier `sv03.5-037`, `sure`, score 0,97, 1 649 ms |
| **V.12** | **aucun** |
| **V.13** | **aucun** |

Pas un seul scan n'atteignait `gererScanV2` (c'est elle qui appelle `relayV2` → journal).
La panne n'était donc **pas** dans l'identification, ni dans le déclenchement, ni dans le
décor : **la boucle ne démarrait jamais.**

### Le verrou : `detectLoop` attendait le worker OCR de la V1

```js
// AVANT — dans startAimLoop()
Promise.all([workerCall('init'), detectWorkerCall('init')])   // workerCall = OCR, ~6 Mo
  .then(() => { ocrReadyForCamera = true; ... })
```
et en tête de `detectLoop` : `if(… || !ocrReadyForCamera) { setTimeout(detectLoop,150); return; }`

Si l'init OCR échoue — et sur un téléphone qui charge déjà l'index V2 (~3 Mo) + DINOv2 +
ORB + le détecteur (~3,5 Mo), la mémoire suffit à la faire échouer — le drapeau reste faux
**pour toujours** et la boucle tourne à vide, 150 ms après 150 ms, sans jamais rien tenter.

**En V.11 ça ne se voyait pas** : le repli V1/OCR prenait le relais. En supprimant la V1
(V.12) on a supprimé le repli **sans supprimer le verrou qui l'attendait**. Et en V.13, en
retirant la bulle d'aide, on a supprimé le dernier message qui aurait pu le dire.

**Corrigé** : la boucle n'attend plus que `detectWorkerCall('init')` — le détecteur de
contours, seul moteur dont elle dépend. La V2 n'a aucun besoin du worker OCR : `scan-v2.js`
embarque le sien pour le départage. Drapeau renommé `ocrReadyForCamera` → **`detecteurPret`**,
parce que le nom mentait sur ce qu'il gardait. **Vérifié** : worker OCR volontairement mis en
panne (`workerCall` qui lève), le scan aboutit quand même (Pikachu #025 identifié).

### L'ouverture caméra vient maintenant du banc, telle quelle

Le banc marche sur le téléphone de Nikos, pas cette page — alors que la chaîne
d'identification est le même module. La différence était tout autour de l'ouverture :

- `enumerateDevices()` + **`choisirObjectifNet()`**, qui **arrête et rouvre la caméra**
  plusieurs fois pour tester les objectifs. Android relâche le capteur en différé : c'est la
  cause connue des « Could not start video source » et des aperçus noirs — `RELACHE_CAMERA_MS`
  a justement été écrit pour ça.
- `applyTrackTweaksAndDiagnostics()` : `frameRate`, `focusMode`, zoom mémorisé appliqués
  avant même la première image.

`startCamera()` fait désormais ce que fait le banc, et rien de plus :
```js
getUserMedia({ video:{ facingMode:{ideal:'environment'}, width:{ideal:1920},
                       height:{ideal:1440}, advanced:[{focusMode:'continuous'}] }, audio:false })
```
`buildCameraConstraints`, `choisirObjectifNet`, `switchLens`, `reprendreCamera` restent dans
le fichier (le bouton « changer d'objectif » des réglages s'en sert) mais **ne sont plus sur
le chemin du démarrage**. Conséquence assumée : `availableCameras` n'est plus rempli au
démarrage, donc le bouton d'objectif reste masqué — module à rebrancher plus tard.

### Une panne muette ne doit plus être possible

L'autre attente (`SCAN_V2.pretV2()`) pouvait geler la session en silence de la même façon.
Elle **parle** maintenant, par le bandeau (`toast`, espacé de 6 s), et **relance
`initV2()`** si personne ne l'a fait. Le bandeau est passé de `z-index:100` à **280** : sous
la caméra plein écran (220) il était invisible — les messages d'erreur ne s'affichaient
littéralement nulle part. (Le plein écran natif porte sur `documentElement`, pas sur la zone
caméra, donc le bandeau est bien dans le sous-arbre rendu — vérifié.)

**Leçon de méthode, la vraie** : `/api/scan-log` répond en trois secondes et dit si le code
a seulement été atteint. Deux versions ont été poussées sans le consulter. **Le lire d'abord.**

## Caméra réduite à l'outil brut du banc (V.13, 2026-09-01)

Retour de Nikos sur la V.12 : « ça ne fonctionne pas. Retire tous les éléments superflus,
car j'ai encore les conseils de cadrage etc. Je veux l'outil brut du bench V2 dans notre
page principale, sans rien excepté le rectangle en bas qui indique la carte capturée. »

**⚠️ Le décor n'était pas la seule cause. Deux appels dans `detectLoop()` touchaient à la
CAMÉRA pendant la détection** — ce que le banc ne fait jamais :

| appelé à chaque image | ce qu'il faisait | conséquence |
|---|---|---|
| `surveillerCadrageV2(d.corners)` | montait le zoom d'un palier quand l'aire < 8 % pendant 2,5 s | cycle d'autofocus → flou + coins déplacés |
| `viserMiseAuPoint(d.corners)` | redemandait la mise au point sur l'illustration dès 5 % de déplacement, au plus toutes les 1,5 s | idem, jusqu'à 40 fois par minute |

Les deux **remettent `v2StableStreak` à zéro juste avant que la série ne se referme**. Sur
une carte tenue à la main, ça se relance en boucle et **le scan ne part jamais**. C'est mot
pour mot le piège déjà documenté pour la V1 (§ « le piège `qualite` » plus bas : *le
correctif contre le flou fabriquait le flou*) — réintroduit en V.11 par une autre porte,
l'aire au lieu de la netteté. `surveillerCadrageV2()` est **supprimée** ; un commentaire
long à sa place explique pourquoi ne pas la remettre. `viserMiseAuPoint()` reste définie
mais **n'est plus appelée**.

**Règle qui en découle, à ne pas réapprendre une troisième fois : on ne modifie pas les
contraintes de la piste vidéo pendant que la boucle de détection tourne.** Objectif, zoom,
point de mise au point : à l'ouverture de la caméra, et plus jamais ensuite. Le banc ne pose
que `focusMode:'continuous'` au démarrage — c'est une des raisons pour lesquelles il marche
mieux.

**Bug de la coupe, trouvé au test** : `flashScreen()` lisait `$('flash').classList` sans
garde. L'élément retiré, **toute identification réussie plantait `gererScanV2`** — la
première carte s'affichait, la suivante jamais. Garde ajoutée. Leçon : après avoir retiré un
élément du DOM, passer en revue TOUTES ses références, pas seulement celles qui sautent aux
yeux (`grep "\$('id')"` puis vérifier le garde ligne par ligne).

**Retiré du cadre caméra** : pastille V2, total de session, bascule auto/manuel, engrenage
réglages, compteur de captures, repère de score, segments d'impression (Normale/Reverse/
Holo), conseil de prise en main, jauges + bouton « i », pastille des récents, **bulle de
conseil de cadrage** (`aim-hint`), bouton d'import, **déclencheur manuel 📸**, repère de
zoom, bande des récents, suggestion de set, bilan de session.

**Gardé** : `<video>`, le cadre (`aim-overlay`), **le rectangle de résultat en bas**
(`live-result`), et **la croix de sortie** — sans elle la caméra ne se coupe plus (seul
ajout non demandé, à dire si Nikos la veut ailleurs).

- **Le CSS et les gestionnaires JS sont laissés en place**, inertes : ils testent tous la
  présence de l'élément. La mise en page et les modules seront rebâtis ensuite un par un,
  sur une base qui marche — c'est ce que Nikos a demandé (« on peaufinera après »).
- **Le cadre porte enfin l'information** : `detectLoop` ne posait que `attente`/`lecture` et
  **ne passait jamais au vert**. Il passe maintenant à `ok` (vert) quand la stabilité est
  acquise, comme au banc. C'est ce qui remplace les phrases d'aide.
- **Plus de mode manuel** : il n'y a plus de déclencheur à presser, donc l'arrêt anticipé
  sur `!autoCaptureEnabled` est retiré de la boucle.
- **`majCadrageVisible()`** réservait 40 px à gauche pour un bandeau de jauges disparu, et
  recentrait le cadre entre une barre du haut et un déclencheur disparus eux aussi : replis
  remis à 0, le cadre se centre sur l'image.

**Vérifié en local** (caméra simulée, `canvas.captureStream`, deux photos réelles de
`photos-test/`) : Dracaufeu-ex #006 → `151 · #006 · Holo · 8,80 €`, puis retrait, puis
Pikachu #025 → `151 · #025 · Normal · 0,10 €`. Enchaînement correct, aucune erreur console.
**Toujours pas testé sur téléphone réel.**

## Unification du scanner sur la logique du banc (V.12, 2026-09-01)

Constat de Nikos : « ce qu'on a dans la page de bench test V2 marche extrêmement mieux
que sur notre scanner principal — je pense qu'il y a des couches qui rentrent en
conflit. » Vrai : `index.html` faisait encore cohabiter la boucle de détection **V1**
(jauges, `conditionsReunies()`, `attemptRead()` avec son propre redressement dupliqué,
`tenterSecours()`) et la logique **V2** posée par-dessus via un `if(actifV2())`, alors
que la case V1/V2 était devenue un choix fictif — plus personne ne repassait en V1 en
pratique, et son plein pipeline restait chargé, actif, à consommer du temps CPU et à
gérer des variables d'état (`absenceStreak`, `lowScoreStreak`…) que la V2 réarmait de son
côté avec ses propres compteurs. Deux machines à états sur la même boucle, chacune
persuadée d'être aux commandes.

**Décision : la V2 devient le seul scanner, en reprenant telle quelle la boucle de
déclenchement déjà validée dans `bench-v2.html`.** Plus un choix de mode — un scanner.

- **V1 sauvegardée avant suppression** (consigne explicite de Nikos) : branche git
  `archive/v1-numero`, poussée sur origin, figée au dernier commit avant toute coupe. À
  restaurer en entier si la reconnaissance visuelle s'avérait un jour insuffisante.
- **Supprimé** : `surveillerNettete()`, `indiceVisee()`/`conseilActif` (déjà des no-op
  morts sous la garde `qualiteTimer`, voir § piège plus bas), `conditionsReunies()`,
  `attemptRead()` en entier (~450 lignes — pré-filtre de forme, comparaison de netteté
  entre deux images, redressement dupliqué, dédoublonnage par hash, `choisirCandidat`),
  `tenterSecours()` et ses constantes (`SECOURS_BLOCAGE_MS`, `blocageDepuis`), toutes les
  variables d'état V1 orphelines (`absenceStreak`, `lowScoreStreak`,
  `SAME_CARD_MOVE_THRESHOLD`, `ECHECS_AVANT_SECOURS`…).
- **Ajouté** : `attemptReadV2(corners, score)` (~25 lignes) — redresse via
  `redresserAvecCoins()` (le MÊME helper déjà utilisé par la prise manuelle et l'import
  photo, donc plus qu'un seul redressement dans tout le fichier) puis appelle
  `gererScanV2()` directement, sans repli OCR intermédiaire.
- **`detectLoop()` réécrite** : reprend mot pour mot la logique de patience/stabilité du
  banc (seuils qui se desserrent avec `v2PresentDepuis` — voir § PATIENCE plus bas,
  inchangée dans son principe), sans plus aucune branche V1. Garde ajoutée en tête,
  absente du code d'origine : `if(!SCAN_V2.pretV2()) { attendre }` — l'ancien code
  retombait naturellement sur l'OCR pendant le téléchargement de l'index V2 ; sans V1 à
  qui se raccrocher, sans cette garde la caméra aurait tenté des identifications vouées à
  l'échec pendant tout le chargement.
- **Case ⚙️ V1/V2 masquée** (`#chk-scan-v2` reste dans le DOM, cochée, `display:none` —
  le module JS lit encore son état) ; texte remplacé par une description honnête du
  scanner. **La pastille `V2` dans la caméra n'est plus un bouton de bascule** — juste un
  indicateur d'état (vert = prêt, cliquer ouvre les réglages).

**Vérifié en local** (`localhost:8802`, mode « Continuer sans compte » — pas de vraie
caméra disponible dans le navigateur de test, flux simulé via
`canvas.captureStream(30)` + `navigator.mediaDevices.getUserMedia` remplacé, deux photos
réelles de `photos-test/`) :
- Chaîne complète caméra → `detectLoop` → `attemptReadV2` → `gererScanV2` → panneau du
  bas : carte 1 (Dracaufeu-ex #006) identifiée avec confiance, fiche correcte affichée
  dans le cadre du bas (nom, ensemble, numéro, cote).
- Carte 2 (Arbok ex #024) : détection et cadrage corrects, mais identification jugée
  incertaine par `gererScanV2` → correctement envoyée en « Non lue — à confirmer », donc
  la branche `rebut` du panneau du bas fonctionne aussi (comportement de `gererScanV2`
  lui-même, non modifié par ce chantier).
- Cycle retrait/nouvelle carte : après une lecture, présenter un fond neutre puis une
  carte différente relance bien un nouveau cycle de détection (pas de blocage sur
  « ✓ lue »).
- Aucune erreur JS pendant tout le test (console vérifiée après chaque étape).
- **Pas encore testé sur téléphone réel** — seule la simulation en navigateur de bureau a
  été faite cette session. La logique portée est celle déjà validée sur le banc, mais un
  test en conditions réelles (main qui tremble, vraie caméra, vrai éclairage) reste à
  faire avant de considérer le réglage terminé.

**Volontairement laissé pour plus tard** (« on viendra peaufiner le reste après »,
Nikos) : le sous-système des jauges (`demarrerQualite`/`echantillonnerQualite`/
`rendreJauges`) est maintenant inerte en permanence mais pas retiré ; plusieurs aides OCR
(`choisirCandidat`, `resolveLiveResult`, le handler `'read'` du worker OCR,
`hexHamming`, `noterMesureLecture`) ne sont plus appelées depuis la boucle live mais
servent peut-être encore à l'import photo par lot ou au panneau « 🔬 Debug OCR » — pas
audité, à trancher avec Nikos avant de couper.

## Objectif automatique en V2 + tentative anti-bruit (V.11, 2026-09-01)

Nikos a demandé « force le zoom x1 sur tous les téléphones », puis lui-même corrigé en
« plutôt forcer l'objectif PRINCIPAL, pas x1 ». Bon réflexe — forcer `zoom:1` est
**exactement** ce que `index.html` a déjà essayé et rejeté (voir § OBJECTIF ci-dessous,
~ligne 9330) : sur un Samsung réel, `zoom:1` du navigateur EST le grand-angle 0,6×. Aucune
valeur numérique fixe ne peut être « le principal » de façon universelle.

**Ce qui existait déjà et marchait, mais seulement en V1** : `surveillerNettete()` +
`preparerCorrectionObjectif()` — une correction « sur constat » qui monte les paliers de
zoom (`min×1.7`, `min×2.5`) quand le flou persiste 2,5 s, et qu'une capture réussie valide
et mémorise (`validerObjectifCourant()`, dans `localStorage` — `pokescanZoomPref`). Le
problème : `surveillerNettete()` est coupée en V2 (`if(!qualiteTimer) return`, voir le
piège plus bas) — **donc cette correction ne se déclenchait JAMAIS en V2**. La caméra
pouvait rester ouverte sur le grand-angle toute une session, sans que rien ne réagisse.

**Fix : `surveillerCadrageV2()`**, miroir exact de `surveillerNettete()` mais déclenchée
par l'**aire** (part du cadre occupée par la carte) au lieu du flou — le signal qu'on a
établi comme LE facteur dominant de la détection (banc de détection, V.9). Sous
`AIRE_LIMITE_V2` (0,08) pendant 2,5 s → monte au palier suivant. Partage `paliersObjectif`
/ `palierCourant` / `pisteObjectif` avec la version V1 (même mémorisation au succès,
`validerObjectifCourant()` était déjà appelée dans `gererScanV2` — il ne manquait QUE le
déclencheur). Testé en isolant l'état (petite carte → armé sans agir → délai simulé → zoom
1,7× appliqué ; grande carte ensuite → réarmement sans re-déclenchement ; paliers épuisés →
abandon propre ; hors V2 → aucun effet).

**Bruit en faible lumière** — hypothèse : le pilote caméra enclenche un mode nuit par
empilement de plusieurs expositions longues, physiquement incompatible avec une cadence
d'image élevée. Ajouté `frameRate:{ideal:30}` dans `buildCameraConstraints()` (contraintes
initiales) + retenté dans `applyTrackTweaksAndDiagnostics()` (certains navigateurs
n'honorent pas `advanced` au premier essai). **Non vérifié sur téléphone** — c'est un levier
plausible et sans risque (ideal, jamais exact ; aucune dégradation possible si non
supporté), pas une certitude. Le diagnostic remonte maintenant `frameRate capacités=` et
`réglage=` : à lire après un test en salon peu éclairé pour savoir si Chrome honore la
demande et si le bruit diminue. Si non concluant, il faudra regarder `exposureMode`/
`exposureTime` — capacités déjà loggées nulle part encore, à ajouter si besoin.

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
- Import du module : **`./scan-v2.js?v=17`** dans `index.html` (bumper à chaque modif de
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
3. ~~**Étendre la tranche** aux séries antérieures~~ — **FAIT le 2026-09-01** : 185/185 sets,
   18 646 cartes, les 18 séries sont en ligne (voir « Catalogue complet en ligne » en tête de
   fichier). Le texte ci-dessous décrit l'état d'avant, gardé pour le contexte.
   ~~Étendre la tranche aux séries antérieures (`base,neo,ecard,ex,pop,dp,pl,hgss,col,bw,
   xy,sm`) quand la V2 sera validée — **`build.html` sait maintenant composer la commande**
   (voir § « Sélecteur de séries » plus bas) : Nikos coche, copie, colle dans son terminal.
   Compter ~2 h de plus pour XY+SM (35 sets, 4 840 cartes), plus si tout l'historique.
   Les 3 `rebut` de la session de 20h44 (`swsh10-082`, `swsh5-79`, `sv03-175` — clés
   prédites, donc fausses) étaient sans doute des cartes hors tranche.~~
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
- **`build.html`** (racine, déployé) — tableau de bord live lisant `status.json`,
  **et sélecteur de séries** (voir juste en dessous).
- Build complet ~2 h pour 7 591 cartes (~585 ms/carte : dl 166 + emb 218 + orb 170 + hash 30).

### Sets « impossibles à télécharger » dans une série déjà faite — corrigé (2026-09-01)

Retour de Nikos : dans des séries déjà construites, certains sets restent « à construire »
sans jamais avancer — les promos, la Galerie de Dresseurs, les énergies. **Cause : un seul
filtre dans `cartesDuSet()` (`tools/build-packs/lib.mjs`)**, qui exigeait un `localId`
purement numérique. Toute carte numérotée autrement (`SWSH001`, `TG01`, `GG01`, `SV001`…)
était rejetée — le set entier tombait à 0 carte exploitable, silencieusement.

**Deux causes distinctes, deux réglages** :
1. **Numérotation non numérique** — le filtre lui-même. Retiré : n'importe quel `localId`
   est accepté du moment qu'il y a une image. Le numéro affiché suit ce qui est imprimé
   (`TG01` reste `TG01`, `025` devient `25` comme avant).
2. **Pas de scan français chez TCGdex** — beaucoup de sets anciens/promo (Diamant & Perle,
   L'appel des Légendes, la plupart des promos SM/HGSS) n'ont **aucune** image côté FR, dans
   aucun des deux endpoints TCGdex. Repli sur l'illustration **anglaise** (même carte, même
   zone d'illustration, seul le texte diffère — sans conséquence pour une identification qui
   ne lit jamais le texte). **Vérifié avec le vrai code (`node -e ...cartesDuSet...`)** :
   `dp1` (130 cartes), `col1` (106), `cel25cc` (25) passent de 0 à leur plein effectif.
3. **Trois sous-sets d'exception** — Galerie de Dresseurs (`…tg`), Galerie Galaroise (`…gg`),
   Coffre Étincelant (`…sv`) : ni FR ni EN sous leur propre id, mais l'image existe dans le
   dossier du set **parent**, même numéro local. Deviné puis confirmé à la main
   (`assets.tcgdex.net/fr/swsh/swsh9/TG01/high.webp` → 200). Téléchargement réel testé :
   fonctionne (86 Ko récupérés pour `swsh9tg-TG01`).
- **~1 550 cartes supplémentaires deviennent exploitables** rien qu'avec le repli anglais
  (mesuré sur un échantillon de 53 sets). **~860 restent introuvables** même en anglais —
  surtout les **kits du dresseur (`tk`)** et les **collections **McDonald's (`mc`)**,
  probablement jamais numérisées nulle part.
- **`telecharger()` échoue maintenant en 10 s, une seule fois**, sur un délai dépassé (pas
  de 4 réessais) : une URL devinée qui ne mène nulle part restait auparavant en attente
  indéfiniment (constaté : un dossier de set inexistant sur `assets.tcgdex.net` ne 404 pas,
  il reste muet). Sans ce garde-fou, chaque carte d'un set irrécupérable aurait coûté
  jusqu'à 40 s au lieu de 10 — des dizaines de minutes perdues sur `tk`/`mc`.
- **Conseil pour le prochain build** : laisser `tk` et `mc` décochés dans le sélecteur de
  `build.html` pour l'instant — la plupart de leurs cartes vont échouer (10 s chacune,
  proprement loggé, sans rien casser, mais ça n'avance à rien).
- **Aucun `rebuild-all` nécessaire** : les sets manquants (`swshp`, `swsh9tg`…) ne sont
  simplement jamais entrés dans `manifest.sets` — un run normal `SERIES=swsh,sv,me bash
  run.sh` les construit tout seul, sans retoucher aux sets déjà faits.

### Sélecteur de séries dans `build.html` — granularité SET (v2, 2026-09-01)

`build.html` compose la commande à lancer pour ajouter les séries manquantes, avec le
détail set par set — Nikos n'a plus à se souvenir des identifiants TCGdex ni de leur ordre.

**⚠️ Rappel factuel** (Nikos a cru un temps que la tranche allait « de XY à aujourd'hui ») :
la tranche en ligne est **swsh+sv+me = 2020→aujourd'hui**. XY (2013) n'y est PAS. Toute la
préhistoire — base, misc, neo, ecard, ex, pop, tk, dp, pl, hgss, col, bw, mc, xy, sm — manque.

- **Rien de codé en dur** : la liste des 19 séries, leur ordre (par `releaseDate` réelle, pas
  une liste écrite à la main) et le détail de chaque set viennent tous, en direct, de l'API
  TCGdex — la même source que le build lui-même (`lib.mjs`, `setsDeLaSerie`). Une série que
  TCGdex ajoute apparaît sans toucher au code.
- **Chaque série est un `<details>` dépliable** listant tous ses sets individuellement (nom,
  cartes, ✓ déjà sur R2 / à construire). ~200 sets au total,~19 séries. Boutons « Tout
  déplier / Tout replier ».
- **Source de vérité = `manifest.sets`** (les clés réellement présentes sur R2), pas
  `manifest.slice` — plus fiable, direct.
- **Verrouillée dès qu'elle contient NE SERAIT-CE QU'UN set déjà construit**, pas seulement
  quand elle est complète (généralisation nécessaire : constaté que `swsh` n'a que 17/25 sets
  sur R2 — sets promo à 0 carte exploitable comme `mep`/`mee`, jamais des manquants réels,
  mais qui rendraient `swsh` « incomplète » au sens strict).
- **`tcgp` (Pokémon TCG Pocket) à part** : jeu mobile, format de carte différent — listée,
  avec une note, mais décochée par défaut.
- Coché par défaut : tout ce qui n'est pas complet. Temps estimé sur les **cartes
  manquantes seulement** (un set déjà fait est relu en secondes, pas recalculé).
- **La page ne télécharge et n'écrit rien elle-même** — aucune clé R2 n'y transite ; c'est
  toujours `run.sh` sur le poste de Nikos, avec son `.env`, qui travaille (un jeton a déjà
  fuité en clair dans `run.sh` au commit `872c039`, ne pas reproduire).
- **Piège vérifié dans `index.mjs`, raison du verrouillage** : le script ne réinjecte dans
  `index-global.bin` que les sets des séries listées dans le `SERIES` du run courant
  (`main()`, boucle filtrée par `setIds.includes(id)`). Une série avec des sets déjà sur R2
  mais absente de la commande verrait ces cartes disparaître de l'index en production à la
  fin du prochain build — sans que rien ne les efface sur R2 (orphelins). Le sélecteur rend
  cette erreur impossible.

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
- `detectLoop()` (depuis V.12, seule boucle — plus de branche V1) : déclenche sur
  `d.score >= seuilScore && stable` (`v2StableStreak >= 1`, seuils desserrés par
  `v2PresentDepuis`, voir § PATIENCE ci-dessus), **aucune** dépendance aux jauges.
  `dejaLue` empêche de re-scanner une carte déjà lue et toujours en place ; il se
  relâche sur `v2CarteRetiree` (2 images sous le seuil, ~300 ms) ou sur un vrai
  déplacement de la carte. Garde en tête de fonction : attend `SCAN_V2.pretV2()` avant
  de tenter quoi que ce soit (rien à quoi se raccrocher pendant le chargement de l'index).
- `attemptReadV2(corners, score)` (depuis V.12, remplace l'ancien `attemptRead`) :
  redresse via `redresserAvecCoins()`, puis `gererScanV2()` gère tout, jamais de repli
  OCR. Retours : `'traite'` / `'rebut'` / `'reessai'` / `'rejet-doublon'`.
- `gererScanV2()` : identif → si rebut, 2 `'reessai'` puis
  `capturerSansLecture`. Succès : `showLiveResultPending` (photo prise) + `showLiveResultDone`
  (depuis le pack) tout de suite, fiche complète + validation auto en arrière-plan.
- `captureFrame()` / `captureFrameInterne()` : prise manuelle, route par `gererScanV2`
  (V2 est désormais le seul chemin, plus de condition).
- `demarrerQualite()` / `majJaugesSelonMode()` : masquent les jauges + coupent
  l'échantillonnage — désormais permanent, plus de mode V1 où elles servaient.
- `SCAN_V2.relayV2({...})` appelé dans `gererScanV2` (succès et rebut) → `/api/scan-log`.
