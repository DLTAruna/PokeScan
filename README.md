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

## Limites connues

- L'identification n'est pas garantie : elle propose, l'utilisateur confirme.
- Les photos peu nettes ou trop éloignées peuvent ne pas livrer de numéro lisible ;
  dans ce cas seul le nom est exploité et le résultat est marqué « à vérifier ».
- L'envoi vers eBay n'est pas automatique : passage par l'import CSV natif du Seller Hub.
