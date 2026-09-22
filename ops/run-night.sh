#!/usr/bin/env bash
set -uo pipefail
cd ~/prospector
VERTS=$(node -e "require('./config/verticals.json').filter(v=>v.enabled).sort((a,b)=>a.priority-b.priority).forEach(v=>console.log(v.slug))")
for v in $VERTS; do
  FREE=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
  if [ "$FREE" -lt 6 ]; then echo "STOP ${FREE}G free, halting before $v"; break; fi
  echo "=== $v $(date -Is) free=${FREE}G"
  node src/cli discover "$v" --source places-new || continue
  node src/cli qualify  "$v" --resume
  node src/cli audit    "$v" --resume --concurrency 8
  node src/cli extract  "$v"
  node src/cli score    "$v"
done
node src/cli report
echo "=== done $(date -Is)"
