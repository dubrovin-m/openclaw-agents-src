#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
RELEASE_FILE="$ROOT/release.json"
WORKSPACE_LAYOUT_HELPER="$ROOT/workspace-layout.mjs"
RUNTIME_CONTRACT="$REPO_ROOT/runtime-contract.json"
RUNTIME_HELPER="$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs"
[ -f "$RELEASE_FILE" ] || { echo "Task Agent release metadata missing" >&2; exit 2; }
[ -f "$WORKSPACE_LAYOUT_HELPER" ] || { echo "Task Agent workspace layout helper missing" >&2; exit 2; }
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || { echo "Runtime contract source missing" >&2; exit 2; }
EXPECTED_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || { echo "Invalid runtime contract" >&2; exit 2; }
node "$RUNTIME_HELPER" repo-check "$REPO_ROOT" >/dev/null || { echo "Repository runtime contract mismatch" >&2; exit 2; }
RELEASE_ENV=$(EXPECTED_OPENCLAW_VERSION="$EXPECTED_OPENCLAW_VERSION" node - "$RELEASE_FILE" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const targetTaskctl=r?.generation?.taskctl_version,targetSchema=r?.generation?.sqlite_schema;
const tuple=v=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(v||'');return m?m.slice(1).map(Number):null};
const satisfies=(v,range)=>{const m=/^>=(\d+)\.(\d+)\.(\d+)$/.exec(range||''),x=tuple(v);if(!m||!x)return false;const f=m.slice(1).map(Number);return x[0]>f[0]||(x[0]===f[0]&&(x[1]>f[1]||(x[1]===f[1]&&x[2]>=f[2])))};
if(r?.format!=='task-agent-release-v2'||!/^0\.4\.[0-9]+$/.test(targetTaskctl||'')||!Number.isSafeInteger(targetSchema)||targetSchema<1||!tuple(r?.generation?.openclaw_build_version)||!satisfies(process.env.EXPECTED_OPENCLAW_VERSION,r?.generation?.openclaw_compat)||r?.generation?.typebox_version!=='1.3.15'||r?.plugin?.name!=='openclaw-plugin-taskctl'||!/^0\.4\.[0-9]+$/.test(r?.plugin?.version||'')||r?.plugin?.artifact!==`artifacts/openclaw-plugin-taskctl-${r.plugin.version}.tgz`||!/^[0-9a-f]{64}$/.test(r?.plugin?.sha256||''))process.exit(2);
const q=s=>`'${String(s).replace(/'/g,"'\\''")}'`;console.log(`TARGET_TASKCTL_VERSION=${q(targetTaskctl)}`);console.log(`TARGET_SQLITE_SCHEMA=${q(targetSchema)}`);console.log(`TARGET_PLUGIN_VERSION=${q(r.plugin.version)}`);console.log(`ARTIFACT_REL=${q(r.plugin.artifact)}`);console.log(`EXPECTED_ARTIFACT_SHA=${q(r.plugin.sha256)}`);
NODE
) || { echo "Invalid Task Agent release metadata" >&2; exit 2; }
eval "$RELEASE_ENV"
TARGET_WORKSPACE_LAYOUT=$(node "$WORKSPACE_LAYOUT_HELPER" layout "$RELEASE_FILE") || { echo "Invalid Task Agent workspace layout" >&2; exit 2; }
TARGET_WORKSPACE_FILES=$(node "$WORKSPACE_LAYOUT_HELPER" target-files "$RELEASE_FILE") || { echo "Invalid Task Agent workspace layout" >&2; exit 2; }
ARTIFACT="$ROOT/$ARTIFACT_REL"
ARTIFACT_SHA_FILE="${ARTIFACT%.tgz}.sha256"
TOOLS_JSON=$(node -e "const fs=require('fs');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))))" "$ROOT/config/tasks-tools.json")

fail(){ echo "$*" >&2; exit 2; }
validate_source(){
  [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT_SHA_FILE" ] || fail "release artifact missing"
  local actual listed f; actual=$(sha256sum "$ARTIFACT"|awk '{print $1}'); listed=$(awk 'NF{print $1;exit}' "$ARTIFACT_SHA_FILE"); [ "$actual" = "$EXPECTED_ARTIFACT_SHA" ] && [ "$listed" = "$EXPECTED_ARTIFACT_SHA" ] || fail "release artifact SHA mismatch"
  node - "$ROOT/plugins/taskctl/package.json" "$ROOT/plugins/taskctl/package-lock.json" "$ROOT/plugins/taskctl/openclaw.plugin.json" "$TARGET_PLUGIN_VERSION" "$RELEASE_FILE" <<'NODE' || fail "plugin source identity mismatch"
const fs=require('fs'),v=process.argv[5];const p=JSON.parse(fs.readFileSync(process.argv[2])),l=JSON.parse(fs.readFileSync(process.argv[3])),m=JSON.parse(fs.readFileSync(process.argv[4])),rel=JSON.parse(fs.readFileSync(process.argv[6])),r=l.packages?.[''],t=l.packages?.['node_modules/typebox'],build=rel?.generation?.openclaw_build_version,compat=rel?.generation?.openclaw_compat;if(p.version!==v||m.version!==v||l.version!==v||r?.version!==v||p.dependencies?.typebox!=='1.3.15'||r?.dependencies?.typebox!=='1.3.15'||t?.version!=='1.3.15'||p.devDependencies?.openclaw!==build||r?.devDependencies?.openclaw!==build||p.openclaw?.build?.openclawVersion!==build||p.peerDependencies?.openclaw!==compat||r?.peerDependencies?.openclaw!==compat||p.openclaw?.compat?.pluginApi!==compat)process.exit(2);
NODE
  for f in $TARGET_WORKSPACE_FILES; do [ -f "$ROOT/workspace/$f" ] || fail "workspace source missing: $f"; done
  if [ "$TARGET_WORKSPACE_LAYOUT" = "agents-md-tools-v1" ]; then
    [ -f "$ROOT/workspace/TOOLS.md" ] || fail "retired TOOLS.md migration source missing"
  fi
}
validate_source

normalize_test_root(){ local candidate=$1 resolved; case "$candidate" in /*) ;; *) fail "--test-root must be an absolute path";; esac; install -d -m 700 "$candidate"; resolved=$(realpath -e "$candidate"); case "$resolved" in /|/home/dubrovin|/home/dubrovin/.openclaw|/home/dubrovin/.openclaw/*|/home/dubrovin/.local|/home/dubrovin/.local/*|/home/dubrovin/.config/systemd|/home/dubrovin/.config/systemd/*) fail "Refusing unsafe test root: $resolved";; esac; printf '%s\n' "$resolved"; }

effective_workspace_files(){
  local test_root=$1
  if [ -n "$test_root" ] && [ "${TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT:-0}" != "1" ]; then
    printf '%s\n' 'AGENTS.md SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md'
  else
    printf '%s\n' "$TARGET_WORKSPACE_FILES"
  fi
}

run_isolated_install(){
  local test_root=$1; test_root=$(normalize_test_root "$test_root"); find "$test_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q . && fail "Isolated install requires an empty test root: $test_root"
  local openclaw_bin node_bin_dir isolated_path test_home state_dir config_path workspace agent_dir bin_dir taskctl_target db_path agent_json health f workspace_files
  openclaw_bin=$(command -v openclaw || true); [ -n "$openclaw_bin" ] || openclaw_bin="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"; [ -x "$openclaw_bin" ] || fail "Unable to locate OpenClaw executable for isolated install"
  node_bin_dir=$(dirname "$(command -v node)"); isolated_path="$node_bin_dir:/usr/bin:/bin"; test_home="$test_root/home"; state_dir="$test_root/state"; config_path="$state_dir/openclaw.json"; workspace="$test_root/workspace-tasks"; agent_dir="$state_dir/agents/tasks/agent"; bin_dir="$test_root/bin"; taskctl_target="$bin_dir/taskctl"; db_path="$state_dir/data/tasks/tasks.sqlite3"
  node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Unsupported Node runtime"
  test "$(env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow OPENCLAW_HOME="$test_home" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" --version|awk '{print $2}')" = "$EXPECTED_OPENCLAW_VERSION"
  node --check "$ROOT/taskctl"; bash "$ROOT/tests/smoke.sh" "$ROOT/taskctl"; bash "$ROOT/tests/batch4.sh"
  install -d -m 700 "$test_home" "$state_dir" "$workspace" "$agent_dir" "$bin_dir" "$(dirname "$db_path")"; install -m 700 "$ROOT/taskctl" "$taskctl_target"
  workspace_files=$(effective_workspace_files "$test_root")
  if [ "$TARGET_WORKSPACE_LAYOUT" = "agents-md-tools-v1" ] && [ "${TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT:-0}" = "1" ]; then rm -f "$workspace/TOOLS.md"; fi
  for f in $workspace_files; do install -m 644 "$ROOT/workspace/$f" "$workspace/$f"; done
  agent_json=$(node - "$ROOT/config/tasks-agent.fragment.json" "$workspace" "$agent_dir" <<'NODE'
const fs=require('fs'),a=JSON.parse(fs.readFileSync(process.argv[2]));delete a.id;a.workspace=process.argv[3];a.agentDir=process.argv[4];process.stdout.write(JSON.stringify(a));
NODE
); node - "$config_path" "$agent_json" <<'NODE'
const fs=require('fs'),a=JSON.parse(process.argv[3]);fs.writeFileSync(process.argv[2],JSON.stringify({agents:{entries:{tasks:a}}},null,2)+'\n');
NODE
  chmod 600 "$config_path"
  oc(){ env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow OPENCLAW_HOME="$test_home" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" "$@"; }
  oc config validate; oc plugins install "$ARTIFACT" --force --accept-capabilities; oc config set 'agents.entries.tasks.tools' "$TOOLS_JSON" --strict-json --dry-run; oc config set 'agents.entries.tasks.tools' "$TOOLS_JSON" --strict-json; oc config validate
  env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" "$taskctl_target" init >/dev/null
  health=$(env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" "$taskctl_target" health)
  node -e 'const h=JSON.parse(process.argv[1]),v=process.argv[2];if(h.implementation_version!==v||h.schema_version!==Number(process.argv[3]))process.exit(2)' "$health" "$TARGET_TASKCTL_VERSION" "$TARGET_SQLITE_SCHEMA"
  test "$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.version||""))' "$state_dir/extensions/taskctl/package.json")" = "$TARGET_PLUGIN_VERSION"
  test "$(stat -c %a "$config_path")" = 600; test "$(stat -c %a "$taskctl_target")" = 700; test "$(stat -c %a "$db_path")" = 600
  printf '\nTASK_AGENT_TEST_ROOT_DEPLOYED\n'
}

if [ "$#" -eq 2 ] && [ "$1" = --test-root ]; then run_isolated_install "$2"; exit 0; fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--test-root /absolute/path]" >&2; exit 2; }

node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Unsupported Node runtime"
test "$(openclaw --version|awk '{print $2}')" = "$EXPECTED_OPENCLAW_VERSION"
node --check "$ROOT/taskctl"; bash "$ROOT/tests/smoke.sh" "$ROOT/taskctl"; bash "$ROOT/tests/batch4.sh"
(cd "$ROOT/plugins/taskctl" && npm ci && npm test && npm run build && npm run plugin:build && npm run plugin:validate)
node -e "const c=require('/home/dubrovin/.openclaw/openclaw.json');if(!c?.agents?.entries?.tasks)process.exit(2)"
openclaw config set "agents.entries.tasks.tools" "$TOOLS_JSON" --strict-json --dry-run
install -m 700 "$ROOT/taskctl" /home/dubrovin/.local/bin/taskctl
if [ "$TARGET_WORKSPACE_LAYOUT" = "agents-md-tools-v1" ]; then rm -f /home/dubrovin/.openclaw/workspace-tasks/TOOLS.md; fi
for f in $TARGET_WORKSPACE_FILES; do install -m 644 "$ROOT/workspace/$f" "/home/dubrovin/.openclaw/workspace-tasks/$f"; done
openclaw plugins install "$ARTIFACT" --force --accept-capabilities; openclaw config set "agents.entries.tasks.tools" "$TOOLS_JSON" --strict-json
openclaw config validate
printf '\nTASK_AGENT_STAGE_DEPLOYED_RELOAD_REQUIRED\n'
