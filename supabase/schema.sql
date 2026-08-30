-- =============================================================================
-- PokéScan — schéma de la base de comptes
--
-- À exécuter UNE FOIS dans Supabase : projet → SQL Editor → coller → Run.
-- Le script est ré-exécutable sans dommage (create if not exists, drop policy if
-- exists) : le relancer après une modification ne détruit aucune donnée.
--
-- Principe : deux tables seulement.
--
--   elements   un enregistrement par carte/produit possédé. C'est le patrimoine,
--              la chose qu'on ne doit jamais perdre. Une ligne par objet permet
--              de FUSIONNER deux appareils au lieu de choisir entre eux : si le
--              téléphone ajoute une carte pendant que l'ordinateur en ajoute une
--              autre, les deux arrivent. Un seul gros document JSON aurait fait
--              gagner le dernier qui écrit, donc perdre l'autre.
--
--   documents  les états d'ensemble qui n'ont de sens que complets : le lot de
--              vente en cours, les listes, l'historique de cote. Les remplacer en
--              bloc est ici le comportement correct.
--
-- Sécurité : RLS activée sur les deux tables, avec des politiques qui comparent
-- auth.uid() à la colonne « utilisateur ». Sans elles, la clé anon publique — qui
-- est dans le code du site, par conception — donnerait accès à TOUTES les lignes
-- de TOUS les comptes. Ne jamais désactiver RLS sur ces tables.
-- =============================================================================

-- --------------------------------------------------------------- les éléments
create table if not exists public.elements (
  utilisateur uuid        not null references auth.users(id) on delete cascade,
  zone        text        not null,
  cle         text        not null,
  contenu     jsonb       not null,
  -- Pierre tombale. Supprimer physiquement la ligne ferait revenir l'objet au
  -- prochain envoi de l'appareil qui l'a encore : une suppression doit voyager
  -- comme une modification, sinon elle ne se propage pas.
  supprime    boolean     not null default false,
  -- Horodatage porté par le CLIENT, pas par le serveur : c'est le moment où
  -- l'utilisateur a fait la modification qui départage deux versions, pas le
  -- moment où le réseau a bien voulu la transmettre. Un appareil hors ligne
  -- pendant trois jours ne doit pas écraser une modification plus récente en se
  -- reconnectant.
  maj_a       timestamptz not null default now(),
  primary key (utilisateur, zone, cle),
  constraint zone_connue check (zone in ('collection', 'scelle', 'vrac'))
);

-- La synchronisation ne demande que ce qui a changé depuis la dernière fois :
-- sans cet index, chaque ouverture de l'application relirait tout le patrimoine.
create index if not exists elements_maj_idx on public.elements (utilisateur, maj_a);

-- --------------------------------------------------------------- les documents
create table if not exists public.documents (
  utilisateur uuid        not null references auth.users(id) on delete cascade,
  cle         text        not null,
  contenu     jsonb       not null,
  maj_a       timestamptz not null default now(),
  primary key (utilisateur, cle)
);

-- ------------------------------------------------------------------- sécurité
alter table public.elements  enable row level security;
alter table public.documents enable row level security;

drop policy if exists elements_lecture     on public.elements;
drop policy if exists elements_insertion   on public.elements;
drop policy if exists elements_maj         on public.elements;
drop policy if exists elements_suppression on public.elements;

create policy elements_lecture on public.elements
  for select using (auth.uid() = utilisateur);
create policy elements_insertion on public.elements
  for insert with check (auth.uid() = utilisateur);
create policy elements_maj on public.elements
  for update using (auth.uid() = utilisateur) with check (auth.uid() = utilisateur);
create policy elements_suppression on public.elements
  for delete using (auth.uid() = utilisateur);

drop policy if exists documents_lecture     on public.documents;
drop policy if exists documents_insertion   on public.documents;
drop policy if exists documents_maj         on public.documents;
drop policy if exists documents_suppression on public.documents;

create policy documents_lecture on public.documents
  for select using (auth.uid() = utilisateur);
create policy documents_insertion on public.documents
  for insert with check (auth.uid() = utilisateur);
create policy documents_maj on public.documents
  for update using (auth.uid() = utilisateur) with check (auth.uid() = utilisateur);
create policy documents_suppression on public.documents
  for delete using (auth.uid() = utilisateur);
