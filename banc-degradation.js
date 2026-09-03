// Dégrader une image de référence pour qu'elle ressemble à une photo de téléphone.
//
// ── POURQUOI ─────────────────────────────────────────────────────────────────────────
// Les bancs jouaient jusqu'ici des images de référence tirées de tcgdex : des rendus
// parfaits, à plat, sans grain ni flou. Ils rendaient 216 points d'appariement médians et
// zéro rebut, là où le téléphone de Nikos en rend 56 avec un quart de rebuts. Autrement dit,
// on mesurait un monde qui n'existe pas, et toute optimisation validée sur ce corpus ne
// prouvait rien de l'usage réel.
//
// Ce module ajoute les quatre défauts que produit une vraie prise de vue, dans l'ordre où
// l'appareil les produit :
//
//   1. la main tremble et l'objectif n'est jamais exactement de face → rotation et
//      perspective légères ;
//   2. la mise au point n'est jamais parfaite, et la carte bouge un peu → flou ;
//   3. le capteur ajoute son grain, davantage dans les ombres que dans les hautes lumières
//      — c'est ce qui rend les cartes sombres plus difficiles que les claires ;
//   4. la chaîne de capture compresse en JPEG.
//
// ── CALIBRATION ──────────────────────────────────────────────────────────────────────
// Le niveau REEL a été réglé en balayant quatre intensités sur dix cartes de sets variés,
// jusqu'à retomber sur la médiane observée sur l'appareil de Nikos :
//
//   sans dégradation                 216 inliers, 0 rebut
//   léger   (flou 0,8 · bruit 6)     206 inliers, 0 rebut
//   moyen   (flou 1,4 · bruit 10)    160 inliers, 0 rebut
//   fort    (flou 2,2 · bruit 16)     95 inliers, 1 rebut
//   REEL    (flou 3,0 · bruit 22)     56 inliers, 2 rebuts   ← relevé téléphone : 56
//
// Vérifié sur trois répétitions : 56, 63 et 65 de médiane, une à deux cartes rejetées sur
// dix. Le relevé du 3 septembre au soir donnait 56 et 26 % de rebuts.
//
// Ces nombres ne sont pas une vérité universelle — ils valent pour CET appareil dans les
// conditions de ce soir-là. Mais ils valent infiniment mieux qu'un rendu parfait.

export const REEL = { angle: 5, perspective: 0.05, flou: 3.0, bruit: 22, qualite: 0.50 };
export const FORT = { angle: 4, perspective: 0.04, flou: 2.2, bruit: 16, qualite: 0.60 };
export const MOYEN = { angle: 3, perspective: 0.03, flou: 1.4, bruit: 10, qualite: 0.72 };
export const LEGER = { angle: 2, perspective: 0.02, flou: 0.8, bruit: 6, qualite: 0.85 };
export const AUCUNE = { angle: 0, perspective: 0, flou: 0, bruit: 0, qualite: 1 };

// Rotation, perspective, flou et grain. La compression, elle, demande un aller-retour par
// une image encodée : voir `compresser` ci-dessous.
export function degrader(src, P = REEL, fond = '#1e2126') {
  const W = src.width, H = src.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = fond; g.fillRect(0, 0, W, H);

  g.save();
  g.translate(W / 2, H / 2);
  g.rotate((Math.random() - 0.5) * P.angle * Math.PI / 180);
  // Une vraie perspective demanderait une homographie ; l'étirement anisotrope en donne
  // l'essentiel — une carte vue de biais n'est plus au bon rapport — pour un centième du code.
  g.scale(1 + (Math.random() - 0.5) * P.perspective,
          1 - (Math.random() - 0.5) * P.perspective);
  g.translate(-W / 2, -H / 2);
  if (P.flou > 0) g.filter = 'blur(' + P.flou + 'px)';
  g.drawImage(src, 0, 0);
  g.restore();
  g.filter = 'none';

  if (P.bruit > 0) {
    const d = g.getImageData(0, 0, W, H), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      const lum = (a[i] * 0.3 + a[i + 1] * 0.6 + a[i + 2] * 0.1) / 255;
      // Le grain d'un capteur croît quand la lumière manque : les ombres en portent plus.
      const amp = P.bruit * (1.6 - lum);
      // Trois tirages uniformes valent une gaussienne pour ce qu'on en fait, et coûtent
      // trois fois rien sur deux millions de pixels.
      const n = (Math.random() + Math.random() + Math.random() - 1.5) * amp;
      a[i] = Math.max(0, Math.min(255, a[i] + n));
      a[i + 1] = Math.max(0, Math.min(255, a[i + 1] + n));
      a[i + 2] = Math.max(0, Math.min(255, a[i + 2] + n));
    }
    g.putImageData(d, 0, 0);
  }
  return c;
}

export async function compresser(c, q) {
  if (!(q < 1)) return c;
  const img = new Image();
  img.src = c.toDataURL('image/jpeg', q);
  await img.decode();
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  o.getContext('2d').drawImage(img, 0, 0);
  return o;
}

// Le passage complet, tel qu'un banc doit l'appeler.
export async function photographier(src, P = REEL, fond) {
  return compresser(degrader(src, P, fond), P.qualite);
}
