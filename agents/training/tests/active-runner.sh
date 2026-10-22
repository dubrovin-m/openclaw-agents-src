#!/usr/bin/env bash
set -euo pipefail
umask 077
# Synthetic ACTIVE Training upgrade and rollback; no production state, keys or network.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
OPENCLAW_BIN=$(realpath -e "$OPENCLAW_BIN")
TARGET_HOST_VERSION=$("$OPENCLAW_BIN" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
eval "$(node "$ROOT/deploy-support.mjs" release-env "$REPO_ROOT" "$ROOT/release.json" "$TARGET_HOST_VERSION")"
TMP=$(mktemp -d /tmp/training-active-runner.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
OLD_POLICY="$TMP/old-tools.json"
git -C "$REPO_ROOT" show "$PREDECESSOR_SOURCE_REVISION:agents/training/config/training-tools.json" > "$OLD_POLICY"
init_root() {
  local dir=$1
  local home="$dir/home" state="$dir/state" config="$dir/state/openclaw.json"
  local db="$state/data/training/training.sqlite3"
  mkdir -p "$home" "$state" "$state/workspace-training" "$dir/agent-dir" "$state/secrets"
  printf '{}\n' > "$config"
  for file in AGENTS.md HEARTBEAT.md IDENTITY.md SOUL.md USER.md; do
    git -C "$REPO_ROOT" show "$PREDECESSOR_SOURCE_REVISION:agents/training/workspace/$file" > "$state/workspace-training/$file"
    chmod 600 "$state/workspace-training/$file"
  done
  # Production may have a runtime-specific identity line: never overwrite it.
  printf '\nSynthetic runtime identity (not source-owned)\n' >> "$state/workspace-training/IDENTITY.md"
  printf '000000:synthetic-token-never-used\n' > "$state/secrets/training.token"
  chmod 600 "$state/secrets/training.token"
  HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_STATE_DIR="$state" OPENCLAW_CONFIG_PATH="$config" \
    "$OPENCLAW_BIN" agents add training --workspace "$state/workspace-training" --agent-dir "$dir/agent-dir" --model openai/gpt-5.6-luna --non-interactive --json >/dev/null
  HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_STATE_DIR="$state" OPENCLAW_CONFIG_PATH="$config" \
    "$OPENCLAW_BIN" plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
  node "$ROOT/migration/import.mjs" "$db" "$ROOT/migration/fixtures/synthetic.json" >/dev/null
  node - "$config" "$db" "$state/secrets/training.token" "$OLD_POLICY" <<'NODE'
const fs=require('fs');
const [configPath,db,tokenFile,toolsFile]=process.argv.slice(2);
const c=JSON.parse(fs.readFileSync(configPath,'utf8'));
const a=c.agents.entries;
const t=Array.isArray(a)?a.find(x=>x?.id==='training'):a.training;
t.tools=JSON.parse(fs.readFileSync(toolsFile,'utf8'));
c.plugins ??={};c.plugins.allow=['training'];
c.plugins.entries ??={};c.plugins.entries.training={enabled:true,config:{databasePath:db}};
c.bindings=[{agentId:'training',match:{channel:'telegram',accountId:'training'}}];
c.channels={telegram:{accounts:{training:{
  enabled:true,tokenFile,dmPolicy:'allowlist',allowFrom:['111'],
  groupPolicy:'disabled',groupAllowFrom:[]
}}}};
fs.writeFileSync(configPath,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE
  HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_STATE_DIR="$state" OPENCLAW_CONFIG_PATH="$config" "$OPENCLAW_BIN" config validate >/dev/null
}
assert_version() {
  node - "$1/state/extensions/training/package.json" "$2" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]).version;
if(v!==process.argv[3])process.exit(2);
NODE
}
assert_policy() {
  node - "$1/state/openclaw.json" "$2" <<'NODE'
const fs=require('fs');
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const e=c.agents.entries;
const actual=(Array.isArray(e)?e.find(x=>x?.id==='training'):e.training)?.tools;
const target=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
if(JSON.stringify(actual)!==JSON.stringify(target))process.exit(2);
NODE
}
for scenario in success after-config after-workspace; do
  R="$TMP/$scenario"
  init_root "$R"
  AGENT_ID_SHA=$(sha256sum "$R/state/workspace-training/IDENTITY.md" | awk '{print $1}')
  STORE_SHA=$(sha256sum "$R/state/data/training/training.sqlite3" | awk '{print $1}')
  node "$ROOT/active-upgrade.mjs" --test-root "$R" --preflight | grep -q TRAINING_ACTIVE_UPGRADE_PREFLIGHT_PASS
  if [ "$scenario" = success ]; then
    node "$ROOT/active-upgrade.mjs" --test-root "$R" --apply --source-sha "$SHA" | grep -q TRAINING_ACTIVE_UPGRADE_PASS
    assert_version "$R" "$TARGET_PLUGIN_VERSION"
    assert_policy "$R" "$ROOT/config/training-tools.json"
    cmp -s "$R/state/workspace-training/AGENTS.md" "$ROOT/workspace/AGENTS.md"
    test ! -e "$R/state/backups/training-active-upgrade/.active.lock"
  else
    set +e
    TRAINING_ACTIVE_UPGRADE_TEST_FAIL_STAGE="$scenario" node "$ROOT/active-upgrade.mjs" --test-root "$R" --apply --source-sha "$SHA" >"$TMP/$scenario.out" 2>"$TMP/$scenario.err"
    rc=$?
    set -e
    test "$rc" -ne 0
    grep -q TRAINING_ACTIVE_UPGRADE_FAILED_ROLLED_BACK "$TMP/$scenario.err"
    assert_version "$R" "$PREDECESSOR_PLUGIN_VERSION"
    assert_policy "$R" "$OLD_POLICY"
    test ! -e "$R/state/backups/training-active-upgrade/.active.lock"
    git -C "$REPO_ROOT" show "$PREDECESSOR_SOURCE_REVISION:agents/training/workspace/AGENTS.md" | cmp -s - "$R/state/workspace-training/AGENTS.md"
  fi
  test "$AGENT_ID_SHA" = "$(sha256sum "$R/state/workspace-training/IDENTITY.md" | awk '{print $1}')"
  test "$STORE_SHA" = "$(sha256sum "$R/state/data/training/training.sqlite3" | awk '{print $1}')"
done
# Tampered local recovery path must refuse before any plugin/config/Store write.
UNSAFE="$TMP/unsafe-recovery-path"
init_root "$UNSAFE"
BEFORE=$(sha256sum "$UNSAFE/state/data/training/training.sqlite3" | awk '{print $1}')
ln -s "$TMP" "$UNSAFE/state/backups"
set +e
node "$ROOT/active-upgrade.mjs" --test-root "$UNSAFE" --apply --source-sha "$SHA" >"$TMP/unsafe.out" 2>"$TMP/unsafe.err"
CODE=$?
set -e
test "$CODE" -ne 0
grep -q "Unsafe private recovery directory" "$TMP/unsafe.err"
assert_version "$UNSAFE" "$PREDECESSOR_PLUGIN_VERSION"
assert_policy "$UNSAFE" "$OLD_POLICY"
test "$BEFORE" = "$(sha256sum "$UNSAFE/state/data/training/training.sqlite3" | awk '{print $1}')"
echo TRAINING_ACTIVE_RUNNER_TEST_PASS
