#!/usr/bin/env bash
# Boucle de reprise : relance le builder tant que la tranche n'est pas terminée.
# Le script lui-même reprend au dernier set fini (manifest sur R2).
set -u
export R2_ACCOUNT_ID=8a7457771cfa724d62c8fd4fb97dbaf9
export R2_ACCESS_KEY_ID=e9745a89d268417baaa1f5c50c4b6366
export R2_SECRET_ACCESS_KEY=252a4f48662df7a7e47e04c9f422d8b2a1d58b50d617d3470165a7a00e45a9bc
export R2_BUCKET=pokescan-packs
export SERIES="${SERIES:-swsh,sv,me}"

cd "$(dirname "$0")"
for i in $(seq 1 40); do
  echo "=== tentative $i $(date -u +%H:%M:%S) ==="
  node --expose-gc index.mjs
  code=$?
  echo "=== sortie $code ==="
  if [ $code -eq 0 ]; then
    phase=$(curl -sS "https://pub-3308c2813bb34a7cb0bed0b500e8d8c4.r2.dev/status.json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).phase)}catch(e){console.log('?')}})")
    echo "phase=$phase"
    [ "$phase" = "done" ] && { echo "TERMINÉ"; break; }
    [ "$phase" = "stopped" ] && { echo "STOPPÉ (demande page)"; break; }
  fi
  sleep 5
done
