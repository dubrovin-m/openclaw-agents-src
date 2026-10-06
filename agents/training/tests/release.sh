#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
EXPECTED=$(node "$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs" openclaw-version "$REPO_ROOT/runtime-contract.json")
node "$ROOT/deploy-support.mjs" release-env "$REPO_ROOT" "$ROOT/release.json" "$EXPECTED" >/dev/null
TARGET_SHA=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.plugin.sha256)' "$ROOT/release.json")
TMP=$(mktemp -d /tmp/training-release-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
(
  cd "$ROOT/plugin"
  npm pack --pack-destination "$TMP" >/dev/null
)
BUILT=$(find "$TMP" -maxdepth 1 -name '*.tgz' -print -quit)
[ -n "$BUILT" ] || { echo 'Training package was not materialized' >&2; exit 1; }
ACTUAL_SHA=$(sha256sum "$BUILT" | awk '{print $1}')
[ "$ACTUAL_SHA" = "$TARGET_SHA" ] || { echo "Training package is not reproducible: $ACTUAL_SHA != $TARGET_SHA" >&2; exit 1; }
echo TRAINING_RELEASE_TEST_PASS
