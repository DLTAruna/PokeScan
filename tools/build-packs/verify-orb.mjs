// L'ORB calculé en Node est-il compatible avec l'ORB navigateur ? On recompute les
// descripteurs de sv03.5 en Node et on les matche (Lowe + homographie RANSAC) contre les
// descripteurs navigateur stockés dans le pack. La bonne carte doit écraser les autres.

import fs from 'fs';
import { cv, orb, telecharger } from './lib.mjs';

const PACK = 'C:/Users/Aruna/pokescan/packs/sv03.5.pack';
const N = process.argv[2] ? +process.argv[2] : 15;

const buf = fs.readFileSync(PACK);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const hLen = dv.getUint32(0, true);
const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, hLen)));
let off = 4 + hLen;
const cards = [];
for (const c of header.cards) {
  off += header.embDim;
  const des = new Uint8Array(ab.slice(off, off + c.or * 32)); off += c.or * 32;
  const kpI16 = new Int16Array(ab.slice(off, off + c.or * 4)); off += c.or * 4;
  const kp = []; for (let i = 0; i < c.or; i++) kp.push({ x: kpI16[i * 2], y: kpI16[i * 2 + 1] });
  cards.push({ cle: c.cle, img: c.img, or: c.or, des, kp });
}
console.log('pack', header.set, cards.length, 'cartes · échantillon', N);

const c = await cv();

function matDes(bytes, rows) { const m = new c.Mat(rows, 32, c.CV_8U); m.data.set(bytes); return m; }

function inliers(qdes, qkp, rdes, rkp) {
  if (qdes.rows < 8 || rdes.rows < 8) return 0;
  const bf = new c.BFMatcher(c.NORM_HAMMING, false);
  const knn = new c.DMatchVectorVector();
  const s = [], d = [];
  try {
    bf.knnMatch(qdes, rdes, knn, 2);
    for (let i = 0; i < knn.size(); i++) {
      const pr = knn.get(i); if (pr.size() < 2) continue;
      const m0 = pr.get(0), m1 = pr.get(1);
      if (m0.distance < 0.75 * m1.distance) {
        s.push(qkp[m0.queryIdx].x, qkp[m0.queryIdx].y);
        d.push(rkp[m0.trainIdx].x, rkp[m0.trainIdx].y);
      }
    }
  } catch (e) {}
  knn.delete(); bf.delete();
  const good = s.length / 2;
  if (good < 8) return good;
  const ms = c.matFromArray(good, 1, c.CV_32FC2, s), md = c.matFromArray(good, 1, c.CV_32FC2, d);
  const mk = new c.Mat(); let n = 0;
  try { const H = c.findHomography(ms, md, c.RANSAC, 5, mk); for (let i = 0; i < mk.rows; i++) n += mk.data[i]; H.delete(); } catch (e) { n = good; }
  ms.delete(); md.delete(); mk.delete();
  return n;
}

let bon = 0;
for (let i = 0; i < N; i++) {
  const card = cards[i];
  let ne;
  try { ne = await orb(await telecharger(card.img + '/high.webp')); }
  catch (e) { console.log('skip', card.cle, e.message); continue; }
  const qdes = matDes(ne.bytes, ne.rows);
  const qkp = []; for (let k = 0; k < ne.rows; k++) qkp.push({ x: ne.kp[k * 2], y: ne.kp[k * 2 + 1] });

  // vrai match
  const rdesSelf = matDes(card.des, card.or);
  const self = inliers(qdes, qkp, rdesSelf, card.kp);
  rdesSelf.delete();

  // 4 leurres
  let pire = 0;
  for (const j of [i + 1, i + 3, i + 7, i + 20].map(x => x % cards.length)) {
    if (j === i) continue;
    const rd = matDes(cards[j].des, cards[j].or);
    pire = Math.max(pire, inliers(qdes, qkp, rd, cards[j].kp));
    rd.delete();
  }
  qdes.delete();
  const ok = self > pire * 2 && self >= 12;
  if (ok) bon++;
  console.log(`${card.cle}  self=${self}  pireLeurre=${pire}  ${ok ? 'OK' : '⚠️'}`);
}
console.log(`\n${bon}/${N} cartes où l'ORB Node retrouve nettement la bonne carte navigateur.`);
