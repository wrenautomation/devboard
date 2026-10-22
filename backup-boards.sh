#!/usr/bin/env bash
# Nightly (launchd, 03:30): commit changed boards in ./projects and push. Touches projects/ only, never code.
set -euo pipefail
cd "$(dirname "$0")"
for f in projects/*/canvas-state-v1.json; do python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f"; done
git add -A projects
git diff --cached --quiet && { echo "no board changes"; exit 0; }
git commit -q -m "boards: $(date +%F)" -- projects
git push -q origin HEAD
echo "pushed boards $(date +%F)"
