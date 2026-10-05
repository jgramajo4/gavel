#!/usr/bin/env bash
# Verifies the Gavel Web production build boundary:
#   1. a production build with no API configuration FAILS (no silent defaults);
#   2. a production build with a removed/legacy variable FAILS;
#   3. any `vite build --mode` (staging, development) is held to the same rule;
#   4. a production build with a loopback API origin FAILS;
#   5. a production build with valid configuration SUCCEEDS and the bundle
#      contains the configured origins and no localhost fallback.
# Usage: scripts/web-build-check.sh   (from the repository root)
set -euo pipefail

cd "$(dirname "$0")/../apps/web"
GOOD_GATE=https://api-mainnet.0773h.com
GOOD_INDEX=https://index.0773h.com
log="${TMPDIR:-/tmp}/gavel-web-build-check.log"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "1/5 production build without API config must fail"
if env -u VITE_GAVEL_GATE_API_URL -u VITE_GAVEL_INDEX_API_URL -u VITE_GATE_API_URL \
  npx vite build --mode production --outDir "${TMPDIR:-/tmp}/gavel-web-bad" >"$log" 2>&1; then
  fail "build succeeded without VITE_GAVEL_GATE_API_URL / VITE_GAVEL_INDEX_API_URL"
fi
grep -q "VITE_GAVEL_GATE_API_URL" "$log" || fail "missing-config failure did not name the variable"
echo "   ok: refused ($(grep -m1 -o 'VITE_GAVEL_[A-Z_]*' "$log") named)"

echo "2/5 production build with the removed VITE_GATE_API_URL must fail"
if VITE_GAVEL_GATE_API_URL=$GOOD_GATE VITE_GAVEL_INDEX_API_URL=$GOOD_INDEX VITE_GATE_API_URL=$GOOD_GATE \
  npx vite build --mode production --outDir "${TMPDIR:-/tmp}/gavel-web-bad" >"$log" 2>&1; then
  fail "build succeeded with the legacy VITE_GATE_API_URL set"
fi
grep -qi "renamed" "$log" || fail "legacy-variable failure did not explain the rename"
echo "   ok: refused"

echo "3/5 a non-production --mode is held to the same rule (any built bundle can ship)"
for m in staging development; do
  if env -u VITE_GAVEL_GATE_API_URL -u VITE_GAVEL_INDEX_API_URL -u VITE_GATE_API_URL \
    npx vite build --mode "$m" --outDir "${TMPDIR:-/tmp}/gavel-web-bad" >"$log" 2>&1; then
    fail "vite build --mode $m succeeded without API config"
  fi
done
echo "   ok: refused for staging and development"

echo "4/5 production build with a loopback API origin must fail"
if VITE_GAVEL_GATE_API_URL=https://localhost:8080 VITE_GAVEL_INDEX_API_URL=https://127.0.0.1 \
  npx vite build --mode production --outDir "${TMPDIR:-/tmp}/gavel-web-bad" >"$log" 2>&1; then
  fail "build succeeded with loopback API origins"
fi
grep -q "loopback" "$log" || fail "loopback failure did not say why"
echo "   ok: refused"

echo "5/5 production build with valid config must succeed"
rm -rf dist
VITE_GAVEL_GATE_API_URL=$GOOD_GATE VITE_GAVEL_INDEX_API_URL=$GOOD_INDEX \
  npx vite build --mode production >"$log" 2>&1 || { cat "$log"; fail "valid build failed"; }
grep -q "$GOOD_GATE" dist/assets/*.js || fail "bundle does not contain the Gate API origin"
grep -q "$GOOD_INDEX" dist/assets/*.js || fail "bundle does not contain the index API origin"
if grep -q "localhost:808" dist/assets/*.js; then fail "bundle contains a localhost API fallback"; fi
[ -f dist/index.html ] || fail "dist/index.html missing"
echo "   ok: built; origins embedded; no localhost fallback"
echo "PASS"
