#!/usr/bin/env bash
set -euo pipefail
trap 'rc=$?; case "$-" in *e*) printf "TRAINING_ACTIVE_RUNNER_TEST_FAILURE line=%s exit=%s scenario=%s\\n" "$LINENO" "$rc" "${scenario:-bootstrap}" >&2;; esac' ERR
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
  mkdir -p "$home" "$state" "$state/workspace-training" "$dir/agent-dir" "$state/secrets" "$dir/workspace-tasks" "$dir/tasks-agent"
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
    "$OPENCLAW_BIN" agents add tasks --workspace "$dir/workspace-tasks" --agent-dir "$dir/tasks-agent" --model openai/gpt-5.6-luna --non-interactive --json >/dev/null
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
},tasks:{
  enabled:false,dmPolicy:'allowlist',allowFrom:['222'],
  groupPolicy:'disabled'
}}}};
c.gateway={mode:'local',bind:'loopback',port:18789,auth:{mode:'token',token:'synthetic-never-used-test-only'}};
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
assert_unchanged_unrelated() {
  node - "$1" "$2" <<'NODE'
const fs=require('node:fs');
const before=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const after=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
function strip(v){
  const c=structuredClone(v),e=c.agents.entries;
  if(Array.isArray(e))e.find(x=>x.id==='training').tools=null;
  else e.training.tools=null;
  for(const section of ['entries','installs'])
    if(c.plugins?.[section] && Object.hasOwn(c.plugins[section],'training'))
      c.plugins[section].training=null;
  return c;
}
if(JSON.stringify(strip(before))!==JSON.stringify(strip(after))){
  const a=strip(before),b=strip(after);
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
  console.error('UNRELATED_CONFIG_DRIFT_CATEGORIES',keys.join(','));
  process.exit(2);
}
if(!JSON.stringify(after).includes('synthetic-never-used-test-only'))process.exit(2);
NODE
}
for scenario in success after-config after-workspace; do
  echo "QUALIFY_SCENARIO_START $scenario"
  R="$TMP/$scenario"
  init_root "$R"
  AGENT_ID_SHA=$(sha256sum "$R/state/workspace-training/IDENTITY.md" | awk '{print $1}')
  STORE_SHA=$(sha256sum "$R/state/data/training/training.sqlite3" | awk '{print $1}')
  cp "$R/state/openclaw.json" "$TMP/$scenario.before.json"
  node "$ROOT/active-upgrade.mjs" --test-root "$R" --preflight | grep -q TRAINING_ACTIVE_UPGRADE_PREFLIGHT_PASS
  if [ "$scenario" = success ]; then
    node "$ROOT/active-upgrade.mjs" --test-root "$R" --apply --source-sha "$SHA" | grep -q TRAINING_ACTIVE_UPGRADE_PASS
    assert_version "$R" "$TARGET_PLUGIN_VERSION"
    assert_policy "$R" "$ROOT/config/training-tools.json"
    cmp -s "$R/state/workspace-training/AGENTS.md" "$ROOT/workspace/AGENTS.md"
    test ! -e "$R/state/.training-active-upgrade-recovery/.active.lock"
  else
    set +e
    TRAINING_ACTIVE_UPGRADE_TEST_FAIL_STAGE="$scenario" node "$ROOT/active-upgrade.mjs" --test-root "$R" --apply --source-sha "$SHA" >"$TMP/$scenario.out" 2>"$TMP/$scenario.err"
    rc=$?
    set -e
    test "$rc" -ne 0
    grep -q TRAINING_ACTIVE_UPGRADE_FAILED_ROLLED_BACK "$TMP/$scenario.err"
    assert_version "$R" "$PREDECESSOR_PLUGIN_VERSION"
    assert_policy "$R" "$OLD_POLICY"
    test ! -e "$R/state/.training-active-upgrade-recovery/.active.lock"
    git -C "$REPO_ROOT" show "$PREDECESSOR_SOURCE_REVISION:agents/training/workspace/AGENTS.md" | cmp -s - "$R/state/workspace-training/AGENTS.md"
  fi
  test "$AGENT_ID_SHA" = "$(sha256sum "$R/state/workspace-training/IDENTITY.md" | awk '{print $1}')"
  test "$STORE_SHA" = "$(sha256sum "$R/state/data/training/training.sqlite3" | awk '{print $1}')"
  assert_unchanged_unrelated "$TMP/$scenario.before.json" "$R/state/openclaw.json"
done
# Tampered local recovery path must refuse before any plugin/config/Store write.
echo "QUALIFY_SCENARIO_START unsafe-recovery"
UNSAFE="$TMP/unsafe-recovery-path"
init_root "$UNSAFE"
BEFORE=$(sha256sum "$UNSAFE/state/data/training/training.sqlite3" | awk '{print $1}')
ln -s "$TMP" "$UNSAFE/state/.training-active-upgrade-recovery"
set +e
node "$ROOT/active-upgrade.mjs" --test-root "$UNSAFE" --apply --source-sha "$SHA" >"$TMP/unsafe.out" 2>"$TMP/unsafe.err"
CODE=$?
set -e
test "$CODE" -ne 0
grep -Eq "Unsafe (test runtime path:|private recovery directory)" "$TMP/unsafe.err"
assert_version "$UNSAFE" "$PREDECESSOR_PLUGIN_VERSION"
assert_policy "$UNSAFE" "$OLD_POLICY"
test "$BEFORE" = "$(sha256sum "$UNSAFE/state/data/training/training.sqlite3" | awk '{print $1}')"
# The disposable test-root guard must refuse symlinked home/state children
# even when the outer root itself is a safe directory.
echo "QUALIFY_SCENARIO_START unsafe-children"
for child in home state; do
  CHILD_ROOT="$TMP/unsafe-$child-child"
  init_root "$CHILD_ROOT"
  BEFORE_CONFIG_SHA=$(sha256sum "$CHILD_ROOT/state/openclaw.json" | awk '{print $1}')
  BEFORE_STORE_SHA=$(sha256sum "$CHILD_ROOT/state/data/training/training.sqlite3" | awk '{print $1}')
  mv "$CHILD_ROOT/$child" "$CHILD_ROOT/$child-actual"
  ln -s "$CHILD_ROOT/$child-actual" "$CHILD_ROOT/$child"
  set +e
  node "$ROOT/active-upgrade.mjs" --test-root "$CHILD_ROOT" --apply --source-sha "$SHA" >"$TMP/child-$child.out" 2>"$TMP/child-$child.err"
  rc=$?
  set -e
  test "$rc" -ne 0
  grep -q "Unsafe test root child: $child" "$TMP/child-$child.err"
  test "$BEFORE_CONFIG_SHA" = "$(sha256sum "$CHILD_ROOT/state/openclaw.json" | awk '{print $1}')"
  test "$BEFORE_STORE_SHA" = "$(sha256sum "$CHILD_ROOT/state/data/training/training.sqlite3" | awk '{print $1}')"
  assert_version "$CHILD_ROOT" "$PREDECESSOR_PLUGIN_VERSION"
done
# A nested symlink must never permit test-root escape into another workspace,
# even when the top-level test root and home/state are genuine directories.
echo "QUALIFY_SCENARIO_START unsafe-nested"
for child in workspace-training data; do
  NESTED="$TMP/unsafe-nested-$child"
  init_root "$NESTED"
  SNAP=$(sha256sum "$NESTED/state/workspace-training/AGENTS.md" "$NESTED/state/data/training/training.sqlite3")
  mv "$NESTED/state/$child" "$NESTED/state/$child-real"
  ln -s "$NESTED/state/$child-real" "$NESTED/state/$child"
  set +e
  node "$ROOT/active-upgrade.mjs" --test-root "$NESTED" --apply --source-sha "$SHA" >"$TMP/nested-$child.out" 2>"$TMP/nested-$child.err"
  CODE=$?
  set -e
  test "$CODE" -ne 0
  grep -q 'Unsafe test runtime path:' "$TMP/nested-$child.err"
  test "$SNAP" = "$(sha256sum "$NESTED/state/workspace-training/AGENTS.md" "$NESTED/state/data/training/training.sqlite3")"
  assert_version "$NESTED" "$PREDECESSOR_PLUGIN_VERSION"
done
# An unproven accepted plugin operation must block automatic rollback/retry.
echo "QUALIFY_SCENARIO_START unknown-outcome"
UNKNOWN="$TMP/unknown-external-outcome"
init_root "$UNKNOWN"
STORE_BEFORE=$(sha256sum "$UNKNOWN/state/data/training/training.sqlite3" | awk '{print $1}')
set +e
TRAINING_ACTIVE_UPGRADE_TEST_UNKNOWN_STAGE=after-install node "$ROOT/active-upgrade.mjs" --test-root "$UNKNOWN" --apply --source-sha "$SHA" >"$TMP/unknown.out" 2>"$TMP/unknown.err"
UNKNOWN_CODE=$?
set -e
test "$UNKNOWN_CODE" -ne 0
grep -q TRAINING_ACTIVE_UPGRADE_RECOVERY_REQUIRED "$TMP/unknown.err"
test -d "$UNKNOWN/state/.training-active-upgrade-recovery/.active.lock"
assert_version "$UNKNOWN" "$TARGET_PLUGIN_VERSION"
assert_policy "$UNKNOWN" "$OLD_POLICY"
test "$STORE_BEFORE" = "$(sha256sum "$UNKNOWN/state/data/training/training.sqlite3" | awk '{print $1}')"
# A disposable outer root is insufficient if a nested runtime directory
# or the configuration file is a symlink. Reuse one installed fixture to keep
# these negative checks bounded; every attempt must refuse before CLI mutation.
NESTED_ROOT="$TMP/unsafe-nested-runtime"
init_root "$NESTED_ROOT"
NESTED_CONFIG_SHA=$(sha256sum "$NESTED_ROOT/state/openclaw.json" | awk '{print $1}')
NESTED_DB_SHA=$(sha256sum "$NESTED_ROOT/state/data/training/training.sqlite3" | awk '{print $1}')
for relative in state/workspace-training state/data/training state/extensions/training state/openclaw.json; do
  candidate="$NESTED_ROOT/$relative"
  mv "$candidate" "$candidate-original"
  ln -s "$candidate-original" "$candidate"
  set +e
  node "$ROOT/active-upgrade.mjs" --test-root "$NESTED_ROOT" --apply --source-sha "$SHA" >"$TMP/nested.out" 2>"$TMP/nested.err"
  rc=$?
  set -e
  test "$rc" -ne 0
  grep -q "Unsafe test runtime path:" "$TMP/nested.err"
  test "$NESTED_CONFIG_SHA" = "$(sha256sum "$NESTED_ROOT/state/openclaw.json" | awk '{print $1}')"
  test "$NESTED_DB_SHA" = "$(sha256sum "$NESTED_ROOT/state/data/training/training.sqlite3" | awk '{print $1}')"
  rm "$candidate"
  mv "$candidate-original" "$candidate"
done
assert_version "$NESTED_ROOT" "$PREDECESSOR_PLUGIN_VERSION"
# Preflight must bind the instruction file being replaced to the *effective*
# Training agent workspace, not merely to an unrelated expected directory.
node - "$NESTED_ROOT/state/openclaw.json" "$NESTED_ROOT/wrong-workspace" <<'NODE'
const fs=require('fs'),p=process.argv[2],wrong=process.argv[3],c=JSON.parse(fs.readFileSync(p,'utf8'));
const e=c.agents.entries,t=Array.isArray(e)?e.find(x=>x?.id==='training'):e.training;
t.workspace=wrong;
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE
set +e
node "$ROOT/active-upgrade.mjs" --test-root "$NESTED_ROOT" --preflight >"$TMP/workspace.out" 2>"$TMP/workspace.err"
rc=$?
set -e
test "$rc" -ne 0
grep -q "Training configured workspace path mismatch" "$TMP/workspace.err"
test "$NESTED_DB_SHA" = "$(sha256sum "$NESTED_ROOT/state/data/training/training.sqlite3" | awk '{print $1}')"
assert_version "$NESTED_ROOT" "$PREDECESSOR_PLUGIN_VERSION"
echo TRAINING_ACTIVE_RUNNER_TEST_PASS
