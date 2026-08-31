#!/usr/bin/env bash
# Boucle de reprise : relance le builder tant que la tranche n'est pas terminée.
# Le script lui-même reprend au dernier set fini (manifest sur R2).
#
# Les clés R2 se mettent dans tools/build-packs/.env (NON commité) :
#   R2_ACCOUNT_ID=...
#   R2_ACCESS_KEY_ID=...
#   R2_SECRET_ACCESS_KEY=...
#   R2_BUCKET=pokescan-packs
set -u
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
: "${R2_ACCOUNT_ID:?clé R2 manquante — voir .env}"
export SERIES="${SERIES:-swsh,sv,me}"
R2_PUB="${R2_PUB:-https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev}"

for i in $(seq 1 40); do
  echo "=== tentative $i $(date -u +%H:%M:%S) ==="
  node --expose-gc index.mjs
  code=$?
  echo "=== sortie $code ==="
  if [ $code -eq 0 ]; then
    phase=$(curl -sS "$R2_PUB/status.json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).phase)}catch(e){console.log('?')}})")
    echo "phase=$phase"
    [ "$phase" = "done" ] && { echo "TERMINÉ"; break; }
    [ "$phase" = "stopped" ] && { echo "STOPPÉ (demande page)"; break; }
  fi
  sleep 5
done
