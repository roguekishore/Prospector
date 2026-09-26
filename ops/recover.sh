#!/usr/bin/env bash
# Re-capture a list of vertical|domain pairs, one at a time, from
# /tmp/rb_pairs.txt. Capture runs extract itself, so nothing follows it.
set -uo pipefail
cd ~/prospector
echo "=== recovery start $(date -Is)  $(wc -l < /tmp/rb_pairs.txt) domains"
while IFS='|' read -r v d; do
  node src/cli capture "$v" --only "$d" 2>&1 | grep -E "$d|robots|error" | head -3
done < /tmp/rb_pairs.txt
echo "=== recovery complete $(date -Is)"
