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

## La devise

Les archives TCGCSV sont en dollars. Les convertir au taux d'**aujourd'hui** serait une
faute : l'euro a bougé de plusieurs pour cent sur la période, et cette variation-là se
retrouverait dans la courbe comme si la carte l'avait faite. C'est le taux **du jour de
chaque relevé** qui compte.

Source : le service de données de la BCE, taux de référence quotidien, gratuit et sans clé.

    https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=…&format=csvdata

Il fait autorité — Frankfurter, souvent cité, n'en est qu'un miroir : vérifié, les deux
donnent 1,1662 dollar pour un euro au 25 août 2026. La BCE ne publie que les jours ouvrés ;
week-ends et fériés reprennent le dernier taux connu.

### La conversion se fait à l'affichage, et voici pourquoi

Convertir dès la reconstitution donnait un résultat juste mais deux fois plus lourd. En
dollars, une carte dont le prix ne bouge pas pendant trois semaines s'écrit *une* valeur et
vingt `null` ; en euros, le taux bougeant chaque jour, les vingt et un jours deviennent
vingt et une valeurs différentes — la compression par répétition ne mordait plus.

Les séries sont donc publiées **en dollars**, compressées, et la table des taux quotidiens
est publiée **à côté**, alignée sur le même index de jours : 938 nombres, treize kilo-octets,
partagés par les 45 000 séries. L'application divise à l'affichage.

    prix en euros = v[i] / taux.v[i]

Vérifié sur Dracaufeu `base1-4` holo : 855,52 $ au 24 août, taux 1,1664 → **733,47 €**, et le
calcul fait à l'affichage redonne exactement la série qu'une conversion en dur produisait.

On y gagne trois choses : le poids, la possibilité d'afficher aussi les dollars, et le fait
qu'une correction de taux ne demande pas de tout reconstruire.

## Ce que ces euros sont, et ne sont pas

C'est le prix du marché **américain**, exprimé en euros. Ce n'est pas un prix Cardmarket :
les deux marchés n'ont pas les mêmes niveaux. Cette série sert à lire une tendance longue,
pas à fixer un prix de vente — pour cela, c'est la série Cardmarket qui fait foi. Les deux
restent séparées : les fondre dessinerait des marches que le marché n'a jamais connues.
