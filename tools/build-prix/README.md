# Historique des cotes — d'où viennent les données

Recherche menée le 3 septembre 2026, sur la question « quelle source donne le maximum
d'historique de prix, gratuitement ». Voici ce qui a été **vérifié**, pas ce qui est
annoncé sur les pages commerciales.

## Ce qui ne marche pas

| Service | Palier gratuit | Historique réel | Marché |
|---|---|---|---|
| PokemonPriceTracker | 100 appels/j | **3 jours** | TCGplayer $ ; Cardmarket € payant |
| TCG API (tcgapi.dev) | 100 req/j | variations 24 h / 7 j / 30 j | TCGplayer $ |
| PokéTrace | 250/j, clé requise | non chiffré nulle part | US + EU |
| pokemontcg.io | oui | aucun | TCGplayer $ |
| TCGdex *(déjà en place)* | illimité, sans clé | `avg1` `avg7` `avg30` | Cardmarket € |

Aucune de ces API ne vend gratuitement une série temporelle. Payer pour trois jours de
recul, ou pour des pourcentages que TCGdex donne déjà sans clé, n'avait pas de sens.

## Ce qui marche

Deux sources publiques, sans clé, sans compte, vérifiées à la main :

### 1. Le guide de prix Cardmarket — EUR, le marché sur lequel on vend

    https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json

15,3 Mo, publié chaque nuit vers 02 h 46, **73 195 produits**, en euros. Champs par
produit : `avg` `low` `trend` `avg1` `avg7` `avg30`, plus les équivalents `-holo`.

Cardmarket ne conserve PAS ses journées passées — les URL datées répondent 403. L'historique
en euros ne peut donc que se construire à partir d'aujourd'hui. Mais `avg30`, `avg7` et
`avg1` donnent d'emblée un mois de recul, et chaque nuit ajoute un point réel.

### 2. Les archives TCGCSV — USD, mais dix-neuf mois de vrai quotidien

    https://tcgcsv.com/archive/tcgplayer/prices-AAAA-MM-JJ.ppmd.7z

Environ 4 Mo par jour compressés, **archive remontant au 8 février 2024**. Le Pokémon est
la catégorie 3 : 7,1 Mo par jour une fois décompressé. Chaque relevé porte `productId`,
`marketPrice`, `lowPrice`, `midPrice` et le nom de l'impression.

## La jointure, qui décide de tout

C'est le point qui rendait l'affaire faisable ou non, et il est réglé : **TCGdex publie les
deux identifiants dans la fiche de chaque carte**, vérifié sur `base1-4` —

    pricing.cardmarket.idProduct              → 273699   (guide Cardmarket)
    pricing.tcgplayer.holofoil.productId      → 42382    (archives TCGCSV)

Aucun rapprochement par nom n'est nécessaire. Le catalogue produits de Cardmarket ne porte
d'ailleurs ni numéro de carte ni code d'extension : le faire à la main sur 73 195 produits
aurait été un travail d'appariement approximatif, pour un résultat faux quelque part.

## Ce que ça donne

- **En euros**, le marché réel de vente : une série qui démarre avec un mois de recul et
  s'allonge d'un point chaque nuit, pour **toutes** les cartes et non les seules scannées.
- **En dollars**, dix-neuf mois de relevés quotidiens véritables, reconstitués en une fois.

Les deux séries restent SÉPARÉES. Les mélanger dessinerait des marches que le marché n'a
jamais connues — une carte n'a pas bondi parce qu'on a changé de source.

## Usage

    node tools/build-prix/backfill.mjs --depuis 2025-09-01 --jusqu 2026-09-03 --sortie ./prix

Télécharge, décompresse, ne garde que la catégorie 3, et écrit une série par `productId`.
Compter environ 4 Mo téléchargés et 87 Mo décompressés transitoirement par journée.
