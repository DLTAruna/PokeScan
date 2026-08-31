# Packs précalculés — index de reconnaissance visuelle

Un `.pack` par set : les **embeddings DINOv2** + **descripteurs ORB** + dHash de toutes les
illustrations officielles du set, sérialisés une fois. Le calcul est identique pour tout le
monde (fonction de l'illustration, qui ne change jamais), donc inutile de le refaire sur
chaque appareil.

`scanner-test.html` télécharge `packs/<setid>.pack` au lieu de calculer l'index localement
(~6 s au lieu de ~5 min pour 200 cartes, et **zéro inférence de référence** sur le téléphone).
Si le pack est absent, il retombe sur la construction locale.

## Format

```
[uint32 LE : longueur de l'en-tête JSON]
[en-tête JSON UTF-8]  { v, set, model, embDim, cards:[{cle, num, name, img, hash, or}] }
[corps binaire]       par carte, dans l'ordre de l'en-tête :
                        int8[embDim]   embedding quantifié (v*127, re-normalisé au chargement)
                        uint8[or*32]   descripteurs ORB
                        int16[or*2]    coordonnées des points d'intérêt (x, y)
```

`model` doit correspondre à `MODELE` dans `scanner-test.html` — un pack généré avec un autre
modèle d'embedding est ignoré.

## Régénérer / ajouter un set

1. Ouvrir `scanner-test.html`, saisir le set, « Charger l'index » (construction locale, longue).
2. « ⬇️ Générer le pack (.pack) » → déposer le fichier ici.
3. Commit.

Taille : ~5 Mo pour 200 cartes (dominé par les descripteurs ORB). Servis gzippés par Vercel.
Pour le catalogue entier il faudra des packs par set/série chargés à la demande, pas un seul
fichier.
