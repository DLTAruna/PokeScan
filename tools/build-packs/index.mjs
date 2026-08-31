// Construit les packs (embeddings + ORB) de toute une tranche du catalogue et les envoie
// sur R2, avec un status.json live que build.html affiche. Reprend après un crash à partir
// du manifest (atomicité au niveau du set). Piloté par /api/build-control (relancer / passer
// / stopper) depuis la page.
//
//   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET  (env, requis)
//   BUILD_CONTROL_URL   (déf. https://poke-scan-drab.vercel.app/api/build-control)
//   SERIES              (déf. swsh,sv,me)

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import zlib from 'zlib';
import { setsDeLaSerie, cartesDuSet, telecharger, embedding, dhash, orb, serialiserPack, MODELE, LOCALE } from './lib.mjs';

const SERIES = (process.env.SERIES || 'swsh,sv,me').split(',').map(s => s.trim());
const SLICE = SERIES.join('+');
const BUCKET = process.env.R2_BUCKET || 'pokescan-packs';
const CONTROL_URL = process.env.BUILD_CONTROL_URL || 'https://poke-scan-drab.vercel.app/api/build-control';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType }));
async function getJson(Key) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key })); return JSON.parse(await r.Body.transformToString()); }
  catch (e) { return null; }
}

// —— état ————————————————————————————————————————————————————————
const t0 = Date.now();
const S = {
  phase: 'init', startedAt: new Date().toISOString(), updatedAt: null, slice: SLICE, model: MODELE, locale: LOCALE,
  sets: { total: 0, done: 0, skipped: [], list: [] },
  current: null,
  cards: { total: 0, done: 0 },
  timing: { elapsedSec: 0, cardsPerMin: 0, etaSec: null, avgMs: {} },
  errors: [], log: [],
};
const acc = { download: [], embed: [], orb: [], hash: [] };
const moy = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
function journal(m) { S.log.unshift(`[${new Date().toISOString().slice(11, 19)}] ${m}`); S.log = S.log.slice(0, 40); console.log(m); }

let dernierPush = 0;
async function pousserStatut(force) {
  const now = Date.now();
  if (!force && now - dernierPush < 2000) return;
  dernierPush = now;
  S.updatedAt = new Date().toISOString();
  S.timing.elapsedSec = Math.round((now - t0) / 1000);
  S.timing.cardsPerMin = S.timing.elapsedSec ? +(S.cards.done / (S.timing.elapsedSec / 60)).toFixed(1) : 0;
  const reste = Math.max(0, S.cards.total - S.cards.done);
  S.timing.etaSec = S.timing.cardsPerMin ? Math.round(reste / S.timing.cardsPerMin * 60) : null;
  S.timing.avgMs = { download: moy(acc.download), embed: moy(acc.embed), orb: moy(acc.orb), hash: moy(acc.hash) };
  try { await put('status.json', JSON.stringify(S), 'application/json'); } catch (e) {}
}

async function lireControle() {
  try {
    const r = await fetch(CONTROL_URL, { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) {}
  return {};
}
async function effacerControle() {
  try { await fetch(CONTROL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"command":""}' }); } catch (e) {}
}

// —— build ————————————————————————————————————————————————————————
async function construireSet(setId) {
  const { nom, cartes } = await cartesDuSet(setId);
  S.current = { set: setId, name: nom, cards: cartes.length, done: 0, step: 'start' };
  journal(`Set ${setId} (${nom}) — ${cartes.length} cartes`);
  const rows = [];
  for (const c of cartes) {
    const ctl = await lireControle();
    if (ctl.command === 'stop') { S.phase = 'stopped'; await pousserStatut(true); process.exit(0); }
    if (ctl.command === 'skip-set') { await effacerControle(); journal(`Set ${setId} passé (demande page)`); S.sets.skipped.push(setId); S.current = null; return null; }
    if (ctl.command === 'restart-set') { await effacerControle(); journal(`Set ${setId} relancé (demande page)`); S.cards.done -= S.current.done; const e = new Error('restart'); e.restart = true; throw e; }

    let img;
    try { let t = Date.now(); img = await telecharger(c.image + '/high.webp'); acc.download.push(Date.now() - t); }
    catch (e) { S.errors.unshift({ set: setId, card: c.cle, msg: 'img ' + e.message }); S.cards.done++; S.current.done++; continue; }

    try {
      S.current.step = 'embed'; let t = Date.now();
      const emb = await embedding(img); acc.embed.push(Date.now() - t);
      S.current.step = 'hash'; t = Date.now();
      const hash = await dhash(img); acc.hash.push(Date.now() - t);
      S.current.step = 'orb'; t = Date.now();
      const o = await orb(img); acc.orb.push(Date.now() - t);
      rows.push({ cle: c.cle, numero: c.numero, name: c.name, image: c.image, hash, emb, rows: o.rows, bytes: o.bytes, kp: o.kp });
    } catch (e) {
      S.errors.unshift({ set: setId, card: c.cle, msg: (e.message || e).slice(0, 120) });
    }
    S.cards.done++; S.current.done++;
    acc.download = acc.download.slice(-200); acc.embed = acc.embed.slice(-200); acc.orb = acc.orb.slice(-200); acc.hash = acc.hash.slice(-200);
    await pousserStatut();
  }
  if (!rows.length) { journal(`Set ${setId} : 0 carte exploitable`); return null; }

  S.current.step = 'upload';
  await pousserStatut(true);
  const pack = serialiserPack(setId, rows);
  await put(`pack-${setId}.pack`, pack, 'application/octet-stream');
  journal(`Set ${setId} : pack envoyé (${(pack.length / 1e6).toFixed(1)} Mo, ${rows.length} cartes)`);
  S.current = null;
  return { cards: rows.length, bytes: pack.length, embRows: rows.map(r => ({ cle: r.cle, numero: r.numero, name: r.name, image: r.image, setId, emb: r.emb })) };
}

async function construireIndexGlobal(tousLesEmb) {
  S.phase = 'global';
  await pousserStatut(true);
  const embDim = 384;
  const count = tousLesEmb.length;
  const head = Buffer.alloc(8);
  head.writeUInt32LE(count, 0); head.writeUInt32LE(embDim, 4);
  const body = Buffer.concat(tousLesEmb.map(r => Buffer.from(r.emb.buffer, r.emb.byteOffset, r.emb.byteLength)));
  await put('index-global.bin', Buffer.concat([head, body]), 'application/octet-stream');

  const meta = tousLesEmb.map(r => ({ c: r.cle, n: r.numero, s: r.setId, m: r.name, i: r.image }));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(meta)));
  await put('index-global-meta.json.gz', gz, 'application/octet-stream');   // gzip brut, décompressé côté client (DecompressionStream)
  journal(`Index global : ${count} cartes, ${((8 + body.length) / 1e6).toFixed(1)} Mo + méta ${(gz.length / 1e3).toFixed(0)} Ko`);
}

async function main() {
  const ctl0 = await lireControle();
  let manifest = (ctl0.command === 'rebuild-all') ? null : await getJson('manifest.json');
  if (ctl0.command === 'rebuild-all') { await effacerControle(); journal('rebuild-all : manifest ignoré'); }
  manifest = manifest || { updatedAt: null, slice: SLICE, model: MODELE, locale: LOCALE, sets: {}, global: null };
  manifest.slice = SLICE; manifest.model = MODELE; manifest.locale = LOCALE;

  // liste ordonnée des sets de la tranche
  const setIds = [];
  for (const serie of SERIES) { try { setIds.push(...await setsDeLaSerie(serie)); } catch (e) { journal('série ' + serie + ' : ' + e.message); } }
  S.sets.total = setIds.length; S.sets.list = setIds;

  // total cartes (pour l'ETA) — cardCount officiel, approximatif
  try {
    const sets = await (await fetch(`https://api.tcgdex.net/v2/${LOCALE}/sets`)).json();
    const parId = Object.fromEntries(sets.map(s => [s.id, s.cardCount?.total || 0]));
    S.cards.total = setIds.reduce((a, id) => a + (parId[id] || 0), 0);
  } catch (e) {}

  S.phase = 'sets';
  const embGlobal = [];
  // ré-injecte les embeddings des sets déjà faits (pour l'index global) en relisant leur pack
  for (const [id, info] of Object.entries(manifest.sets)) {
    if (!setIds.includes(id)) continue;
    S.sets.done++; S.cards.done += info.cards || 0;
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `pack-${id}.pack` }));
      const buf = Buffer.from(await r.Body.transformToByteArray());
      const hLen = buf.readUInt32LE(0);
      const h = JSON.parse(buf.slice(4, 4 + hLen).toString('utf-8'));
      let off = 4 + hLen;
      for (const cc of h.cards) {
        const emb = new Int8Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + h.embDim));
        off += h.embDim + cc.or * 32 + cc.or * 4;
        embGlobal.push({ cle: cc.cle, numero: cc.num, name: cc.name, image: cc.img, setId: id, emb });
      }
      journal(`Set ${id} déjà fait — ${h.cards.length} embeddings relus`);
    } catch (e) { journal(`Set ${id} déjà fait mais pack illisible (${e.message}) — sera refait`); delete manifest.sets[id]; S.sets.done--; S.cards.done -= info.cards || 0; }
  }
  await pousserStatut(true);

  for (const id of setIds) {
    if (manifest.sets[id]) continue;
    let res;
    try { res = await construireSet(id); }
    catch (e) {
      if (e.restart) { try { res = await construireSet(id); } catch (e2) { journal(`Set ${id} a re-planté : ${e2.message || e2}`); S.errors.unshift({ set: id, card: '(set)', msg: (e2.message || e2).slice(0, 200) }); await pousserStatut(true); continue; } }
      else {
        journal(`Set ${id} a planté : ${(e.message || e)}`);
        S.errors.unshift({ set: id, card: '(set)', msg: (e.message || e).slice(0, 200) });
        await pousserStatut(true);
        continue;   // le prochain lancement le reprendra
      }
    }
    if (res) {
      manifest.sets[id] = { name: S.sets.list.includes(id) ? id : id, cards: res.cards, bytes: res.bytes, builtAt: new Date().toISOString() };
      manifest.updatedAt = new Date().toISOString();
      await put('manifest.json', JSON.stringify(manifest), 'application/json');
      embGlobal.push(...res.embRows);
    }
    S.sets.done++;
    await pousserStatut(true);
    if (global.gc) global.gc();
  }

  await construireIndexGlobal(embGlobal);
  manifest.global = { cards: embGlobal.length, builtAt: new Date().toISOString() };
  manifest.updatedAt = new Date().toISOString();
  await put('manifest.json', JSON.stringify(manifest), 'application/json');

  S.phase = 'done'; S.current = null;
  await pousserStatut(true);
  journal(`TERMINÉ — ${S.sets.done}/${S.sets.total} sets, ${embGlobal.length} cartes, ${S.timing.elapsedSec}s`);
}

main().catch(async e => {
  console.error(e);
  S.phase = 'error'; S.errors.unshift({ set: '(global)', card: '', msg: (e.message || String(e)).slice(0, 300) });
  await pousserStatut(true);
  process.exit(1);
});
