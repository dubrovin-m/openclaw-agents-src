#!/usr/bin/env bash
set -euo pipefail
umask 077
# Disposable CI test ONLY: starts a synthetic loopback Gateway. Never production.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
OPENCLAW_BIN=$(realpath -e "$OPENCLAW_BIN")
TARGET_HOST_VERSION=$("$OPENCLAW_BIN" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
eval "$(node "$ROOT/deploy-support.mjs" release-env "$REPO_ROOT" "$ROOT/release.json" "$TARGET_HOST_VERSION")"
TEST_ROOT=$(mktemp -d /tmp/training-active-gateway-qualification.XXXXXX)
HOME_DIR="$TEST_ROOT/home"
STATE_DIR="$TEST_ROOT/state"
CONFIG="$STATE_DIR/openclaw.json"
DB="$STATE_DIR/data/training/training.sqlite3"
GATEWAY_LOG="$TEST_ROOT/gateway.log"
GATEWAY_PID=""
mkdir -p "$HOME_DIR" "$STATE_DIR" "$TEST_ROOT/training-agent" "$TEST_ROOT/workspace-training"
cleanup() {
  if [ -n "$GATEWAY_PID" ]; then
    kill -TERM -- "-$GATEWAY_PID" 2>/dev/null || true
    for i in $(seq 1 40); do
      kill -0 "$GATEWAY_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL -- "-$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}
GATEWAY_PORT=$(free_port)
GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT"
TOKEN="training-disposable-test-only"
oc() {
  HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" \
  OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" OPENCLAW_GATEWAY_URL="$GATEWAY_URL" OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 OPENCLAW_SKIP_GMAIL_WATCHER=1 OPENCLAW_SKIP_CANVAS_HOST=1 \
  OPENCLAW_SKIP_ACPX_RUNTIME=1 OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 "$OPENCLAW_BIN" "$@"
}
printf '{}\n' > "$CONFIG"
oc agents add training --workspace "$TEST_ROOT/workspace-training" --agent-dir "$TEST_ROOT/training-agent" --model openai/gpt-5.6-luna --non-interactive --json >/dev/null
oc plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
node "$ROOT/migration/import.mjs" "$DB" "$ROOT/migration/fixtures/synthetic.json" >/dev/null
PATCH=$(node -e 'process.stdout.write(JSON.stringify({gateway:{mode:"local",bind:"loopback",port:Number(process.argv[2]),auth:{mode:"token",token:process.argv[3]}},plugins:{allow:["training"],entries:{training:{enabled:true,config:{databasePath:process.argv[1]}}}}}))' "$DB" "$GATEWAY_PORT" "$TOKEN")
printf '%s\n' "$PATCH" | oc config patch --stdin >/dev/null
oc config validate >/dev/null
# Gateway process group is isolated, with deterministic teardown on all exits.
HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" \
OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" OPENCLAW_GATEWAY_URL="$GATEWAY_URL" OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 OPENCLAW_SKIP_GMAIL_WATCHER=1 OPENCLAW_SKIP_CANVAS_HOST=1 \
OPENCLAW_SKIP_ACPX_RUNTIME=1 OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 \
setsid "$OPENCLAW_BIN" gateway run --port "$GATEWAY_PORT" >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!
ready() {
  for i in $(seq 1 90); do
    kill -0 "$GATEWAY_PID" 2>/dev/null || { echo "Gateway exited unexpectedly" >&2; return 1; }
    oc gateway status --deep --require-rpc >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Gateway readiness timed out" >&2
  return 1
}
ready || { tail -40 "$GATEWAY_LOG" >&2; exit 2; }
DB_BEFORE=$(sha256sum "$DB" | awk '{print $1}')
assert_version() {
  local want=$1
  oc plugins list --json | node -e '
  let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{
    let p=(JSON.parse(s).plugins||[]).filter(x=>x.id==="training");
    if(p.length!==1||p[0].version!==process.argv[1]||p[0].enabled!==true)process.exit(2)
  });' "$want"
}
assert_version "$PREDECESSOR_PLUGIN_VERSION"
oc plugins install --force --no-enable --accept-capabilities "$ARTIFACT" >/dev/null
ready
assert_version "$TARGET_PLUGIN_VERSION"
oc plugins reload training --wait --json >"$TEST_ROOT/reload-target.json"
node - "$TEST_ROOT/reload-target.json" <<'NODE'
const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(v?.restartRequired===true || !JSON.stringify(v).includes("training"))process.exit(2);
NODE
[ "$(sha256sum "$DB" | awk '{print $1}')" = "$DB_BEFORE" ] || { echo "Training Store changed on live upgrade" >&2; exit 2; }
oc plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
ready
assert_version "$PREDECESSOR_PLUGIN_VERSION"
oc plugins reload training --wait --json >"$TEST_ROOT/reload-predecessor.json"
node - "$TEST_ROOT/reload-predecessor.json" <<'NODE'
const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(v?.restartRequired===true || !JSON.stringify(v).includes("training"))process.exit(2);
NODE
[ "$(sha256sum "$DB" | awk '{print $1}')" = "$DB_BEFORE" ] || { echo "Training Store changed on live rollback" >&2; exit 2; }
echo TRAINING_ACTIVE_GATEWAY_UPGRADE_ROLLBACK_PASS
