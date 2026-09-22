#!/usr/bin/env bash
set -uo pipefail
cd ~/prospector
echo "=== recovery start $(date -Is)  $(wc -l < /tmp/rb_pairs.txt) domains"
while IFS='|' read -r v d; do
  node src/cli audit "$v" --only "$d" 2>&1 | grep -E "$d|robots|error" | head -3
done < /tmp/rb_pairs.txt
echo "=== recapture done, re-running extract/score/report $(date -Is)"
for v in $(cut -d'|' -f1 /tmp/rb_pairs.txt | sort -u); do
  node src/cli extract "$v" 2>&1 | tail -2
  node src/cli score   "$v" 2>&1 | tail -2
done
node src/cli report 2>&1 | tail -3
echo "=== recovery complete $(date -Is)"
