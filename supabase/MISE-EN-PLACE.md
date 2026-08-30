# Activer les comptes et la sauvegarde en ligne

Tant que les deux clés ne sont pas renseignées, l'application tourne comme avant :
tout en local, aucune porte fermée. Rien ne casse si tu remets ça à plus tard.

Ces étapes demandent de créer un compte et de manipuler des clés : elles sont à faire
par toi, pas par Claude.

---

## 1. Créer le projet Supabase

1. Aller sur https://supabase.com et créer un compte (le palier gratuit suffit
   largement : 500 Mo de base, ce qui représente des centaines de milliers de cartes).
2. **New project** → nom `pokescan`, mot de passe de base de données au choix
   (il ne servira pas ici, mais garde-le), région **Europe (Frankfurt)** ou
   **(Paris)** — la plus proche de tes utilisateurs.
3. Attendre deux minutes que le projet soit provisionné.

## 2. Créer les tables

1. Dans le projet : **SQL Editor** → **New query**.
2. Coller tout le contenu de `supabase/schema.sql`.
3. **Run**.

Le script est ré-exécutable sans dommage : le relancer plus tard ne détruit rien.

Vérification : **Table Editor** doit montrer `elements` et `documents`, toutes deux
marquées **RLS enabled**. Si l'une des deux ne l'est pas, ne pas continuer — sans RLS,
n'importe qui pourrait lire les données de tous les comptes.

## 3. Récupérer les deux clés

**Project Settings** → **API** :

- **Project URL** → à copier dans `POKESCAN_SUPABASE_URL`
- **Project API keys** → la clé **`anon` `public`** → à copier dans
  `POKESCAN_SUPABASE_ANON`

Les deux valeurs se mettent en haut de `index.html`, dans le petit bloc `<script>`
prévu pour ça (chercher `POKESCAN_SUPABASE_URL`).

> La clé `anon` est **publique par conception** : elle se trouve dans le code de tout
> site qui parle à Supabase. Ce n'est pas elle qui protège les données, c'est la RLS
> posée à l'étape 2.
>
> **Ne jamais mettre ici la clé `service_role`** : celle-là contourne toute sécurité et
> donnerait un accès total à quiconque ouvre le code source de la page.

## 4. Régler l'authentification

**Authentication** → **Providers** :

- **Email** : activé par défaut. Décider de « Confirm email » :
  - **activé** (recommandé) : l'utilisateur reçoit un lien avant de pouvoir entrer.
  - **désactivé** : l'inscription ouvre la session tout de suite, plus simple pour
    tester. L'application gère les deux cas et affiche le message correspondant.

- **Google** : à activer pour le bouton « Continuer avec Google ». Il faut un
  identifiant OAuth côté Google :
  1. https://console.cloud.google.com → créer un projet.
  2. **APIs & Services** → **OAuth consent screen** → externe, remplir le minimum.
  3. **Credentials** → **Create credentials** → **OAuth client ID** → type
     **Web application**.
  4. Dans **Authorized redirect URIs**, coller l'URL que Supabase affiche sous le
     provider Google (de la forme `https://<projet>.supabase.co/auth/v1/callback`).
  5. Recopier **Client ID** et **Client Secret** dans Supabase, puis enregistrer.

**Authentication** → **URL Configuration** :

- **Site URL** : `https://poke-scan-drab.vercel.app`
- **Redirect URLs** : ajouter la même adresse, et `http://localhost:8802` pour les
  essais en local. Sans ça, le retour de Google atterrit sur une page d'erreur.

## 5. Vérifier

1. Recharger le site : la page de présentation doit s'afficher à la place de
   l'application.
2. Créer un compte avec une adresse e-mail.
3. Scanner ou ajouter une carte, attendre quelques secondes : une pastille
   « Sauvegardé » apparaît en bas.
4. Dans Supabase, **Table Editor** → `elements` : la ligne doit être là.
5. Ouvrir le site dans une fenêtre de navigation privée, se connecter avec le même
   compte : la carte doit revenir.

---

## Ce qui est synchronisé, et ce qui ne l'est pas

| Donnée | Synchronisée | Pourquoi |
|---|---|---|
| Collection (classeur) | oui, carte par carte | c'est le patrimoine |
| Produits scellés | oui, produit par produit | idem |
| Pile vrac | oui | idem |
| Stock de vente | oui, en bloc | une session de travail, pas un patrimoine |
| Listes | oui, en bloc | idem |
| **Photos de capture** | **non** | des centaines de Mo en base64 ; l'illustration officielle suffit à réafficher la carte ailleurs |
| Catalogue, cotes, empreintes | non | ce sont des caches, reconstructibles à tout moment |

La fusion est **additive** : deux appareils qui ont travaillé chacun de leur côté
finissent avec l'union de leurs ajouts. Une suppression voyage comme une modification
(voir `noterSuppression` dans `index.html`), sinon l'appareil qui a encore l'objet le
renverrait au prochain envoi.
