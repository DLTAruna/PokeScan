// Découpe les packs de set (déjà sur R2) en blobs ORB par carte : orb/<cle>.orb
// Format blob : [uint16 LE rows][uint8 rows*32 desc][int16 LE rows*2 kp]  (~25 Ko)
// Le client n'a alors qu'à récupérer les ~30 cartes de sa shortlist (≈750 Ko), quel que
// soit le nombre de sets qu'elles couvrent — au lieu d'aspirer un pack de 5 Mo par set.

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = process.env.R2_BUCKET || 'pokescan-packs';
const s3 = new S3Client({
  region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

async function listePacks() {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'pack-', ContinuationToken: token }));
    for (const o of (r.Contents || [])) if (o.Key.endsWith('.pack')) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : null;
  } while (token);
  return out;
}

async function existe(key) {
  try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: 'bytes=0-0' })); return true; }
  catch (e) { return false; }
}

const packs = await listePacks();
console.log(packs.length, 'packs à découper');
const seulement = process.argv[2];   // ex: pack-sv08.pack pour n'en faire qu'un
let totalCartes = 0;

for (const key of packs) {
  if (seulement && key !== seulement) continue;
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buf = Buffer.from(await r.Body.transformToByteArray());
  const hLen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.slice(4, 4 + hLen).toString('utf-8'));
  let off = 4 + hLen;
  let faits = 0, sautes = 0;
  const jobs = [];
  for (const c of header.cards) {
    off += header.embDim;                                   // embedding : pas dans le blob ORB
    const des = buf.subarray(off, off + c.or * 32); off += c.or * 32;
    const kp = buf.subarray(off, off + c.or * 4); off += c.or * 4;
    const head = Buffer.alloc(2); head.writeUInt16LE(c.or, 0);
    const blob = Buffer.concat([head, des, kp]);
    const okey = 'orb/' + c.cle + '.orb';
    jobs.push({ okey, blob });
  }
  // envoi en parallèle limité
  const CONC = 12;
  for (let i = 0; i < jobs.length; i += CONC) {
    await Promise.all(jobs.slice(i, i + CONC).map(async j => {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: j.okey, Body: j.blob, ContentType: 'application/octet-stream' }));
      faits++;
    }));
  }
  totalCartes += faits;
  console.log(`${header.set} : ${faits} blobs (${(buf.length / 1e6).toFixed(1)} Mo de pack)`);
}
console.log('total', totalCartes, 'blobs ORB');
