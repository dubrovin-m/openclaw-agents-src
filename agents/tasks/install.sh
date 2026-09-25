#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
RELEASE_FILE="$ROOT/release.json"
WORKSPACE_LAYOUT_HELPER="$ROOT/workspace-layout.mjs"
RUNTIME_CONTRACT="$REPO_ROOT/runtime-contract.json"
RUNTIME_HELPER="$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs"
CONTACTS_ROOT="$REPO_ROOT/shared/contacts"
[ -f "$RELEASE_FILE" ] || { echo "Task Agent release metadata missing" >&2; exit 2; }
[ -f "$WORKSPACE_LAYOUT_HELPER" ] || { echo "Task Agent workspace layout helper missing" >&2; exit 2; }
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || { echo "Runtime contract source missing" >&2; exit 2; }
EXPECTED_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || { echo "Invalid runtime contract" >&2; exit 2; }
node "$RUNTIME_HELPER" repo-check "$REPO_ROOT" >/dev/null || { echo "Repository runtime contract mismatch" >&2; exit 2; }
RELEASE_ENV=$(EXPECTED_OPENCLAW_VERSION="$EXPECTED_OPENCLAW_VERSION" node - "$RELEASE_FILE" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const targetTaskctl=r?.generation?.taskctl_version,targetSchema=r?.generation?.sqlite_schema;
const tuple=v=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(v||'');return m?m.slice(1).map(Number):null};
const exactHost=(v,range)=>tuple(v)!==null&&v===range;
const sc=r?.shared_contacts;if(!sc||sc.release_path!=='../../shared/contacts/release.json'||!/^[0-9a-f]{64}$/.test(sc.release_sha256||'')||!/^0\.1\.[0-9]+$/.test(sc.implementation_version||'')||!Number.isSafeInteger(sc.sqlite_schema)||sc.sqlite_schema<1)process.exit(2);
if(r?.format!=='task-agent-release-v2'||!/^0\.4\.[0-9]+$/.test(targetTaskctl||'')||!Number.isSafeInteger(targetSchema)||targetSchema<1||!tuple(r?.generation?.openclaw_build_version)||r?.generation?.openclaw_build_version!==process.env.EXPECTED_OPENCLAW_VERSION||!exactHost(process.env.EXPECTED_OPENCLAW_VERSION,r?.generation?.openclaw_compat)||r?.generation?.typebox_version!=='1.3.15'||r?.plugin?.name!=='openclaw-plugin-taskctl'||!/^0\.4\.[0-9]+$/.test(r?.plugin?.version||'')||r?.plugin?.artifact!==`artifacts/openclaw-plugin-taskctl-${r.plugin.version}.tgz`||!/^[0-9a-f]{64}$/.test(r?.plugin?.sha256||''))process.exit(2);
const q=s=>`'${String(s).replace(/'/g,"'\\''")}'`;console.log(`TARGET_TASKCTL_VERSION=${q(targetTaskctl)}`);console.log(`TARGET_SQLITE_SCHEMA=${q(targetSchema)}`);console.log(`TARGET_PLUGIN_VERSION=${q(r.plugin.version)}`);console.log(`ARTIFACT_REL=${q(r.plugin.artifact)}`);console.log(`EXPECTED_ARTIFACT_SHA=${q(r.plugin.sha256)}`);
NODE
) || { echo "Invalid Task Agent release metadata" >&2; exit 2; }
eval "$RELEASE_ENV"
TARGET_WORKSPACE_LAYOUT=$(node "$WORKSPACE_LAYOUT_HELPER" layout "$RELEASE_FILE") || { echo "Invalid Task Agent workspace layout" >&2; exit 2; }
TARGET_WORKSPACE_FILES=$(node "$WORKSPACE_LAYOUT_HELPER" target-files "$RELEASE_FILE") || { echo "Invalid Task Agent workspace layout" >&2; exit 2; }
ARTIFACT="$ROOT/$ARTIFACT_REL"
CONTACTS_RELEASE="$CONTACTS_ROOT/release.json"
TARGET_CONTACTS_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.implementation_version||""))' "$CONTACTS_RELEASE")
TARGET_CONTACT_TOOL_COUNT=$(node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.contracts.tools.length))' "$CONTACTS_ROOT/plugin/openclaw.plugin.json")
CONTACTS_ARTIFACT="$CONTACTS_ROOT/$(node -e 'const r=require(process.argv[1]);const a=r?.plugin?.artifact;if(typeof a!=="string")process.exit(2);process.stdout.write(a)' "$CONTACTS_RELEASE")"
ARTIFACT_SHA_FILE="${ARTIFACT%.tgz}.sha256"
fail(){ echo "$*" >&2; exit 2; }
TOOLS_JSON=$(node -e "const fs=require('fs');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))))" "$ROOT/config/tasks-tools.json")
MAIN_CONTACTS_TOOLS_JSON=$(node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(JSON.stringify(x)!==JSON.stringify({alsoAllow:['contacts']}))process.exit(2);process.stdout.write(JSON.stringify(x))" "$ROOT/config/main-contacts-tools.json") || fail "Invalid main Contacts tool policy"

validate_source(){
  local contacts_release="$ROOT/$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.shared_contacts.release_path)' "$RELEASE_FILE")" expected_contacts_sha; expected_contacts_sha=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.shared_contacts.release_sha256)' "$RELEASE_FILE"); [ -f "$contacts_release" ] && [ "$(sha256sum "$contacts_release"|awk '{print $1}')" = "$expected_contacts_sha" ] || fail "Shared Contacts release fingerprint mismatch"
  [ -f "$CONTACTS_ROOT/core.cjs" ] && [ -f "$CONTACTS_ROOT/task-store.cjs" ] && [ -f "$CONTACTS_ROOT/contactctl" ] && [ -f "$CONTACTS_ARTIFACT" ] || fail "Shared Contacts source missing"
  node "$CONTACTS_ROOT/validate-release.mjs" >/dev/null || fail "Shared Contacts frozen release invalid"
  node --check "$CONTACTS_ROOT/core.cjs"; node --check "$CONTACTS_ROOT/task-store.cjs"; node --check "$CONTACTS_ROOT/contactctl"
  [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT_SHA_FILE" ] || fail "release artifact missing"
  local actual listed f; actual=$(sha256sum "$ARTIFACT"|awk '{print $1}'); listed=$(awk 'NF{print $1;exit}' "$ARTIFACT_SHA_FILE"); [ "$actual" = "$EXPECTED_ARTIFACT_SHA" ] && [ "$listed" = "$EXPECTED_ARTIFACT_SHA" ] || fail "release artifact SHA mismatch"
  node - "$ROOT/plugins/taskctl/package.json" "$ROOT/plugins/taskctl/package-lock.json" "$ROOT/plugins/taskctl/openclaw.plugin.json" "$TARGET_PLUGIN_VERSION" "$RELEASE_FILE" <<'NODE' || fail "plugin source identity mismatch"
const fs=require('fs'),v=process.argv[5];const p=JSON.parse(fs.readFileSync(process.argv[2])),l=JSON.parse(fs.readFileSync(process.argv[3])),m=JSON.parse(fs.readFileSync(process.argv[4])),rel=JSON.parse(fs.readFileSync(process.argv[6])),r=l.packages?.[''],t=l.packages?.['node_modules/typebox'],build=rel?.generation?.openclaw_build_version,compat=rel?.generation?.openclaw_compat;if(p.version!==v||m.version!==v||l.version!==v||r?.version!==v||p.dependencies?.typebox!=='1.3.15'||r?.dependencies?.typebox!=='1.3.15'||t?.version!=='1.3.15'||p.devDependencies?.openclaw!==build||r?.devDependencies?.openclaw!==build||p.openclaw?.build?.openclawVersion!==build||p.peerDependencies?.openclaw!==compat||r?.peerDependencies?.openclaw!==compat||p.openclaw?.compat?.pluginApi!==compat)process.exit(2);
NODE
  for f in $TARGET_WORKSPACE_FILES; do [ -f "$ROOT/workspace/$f" ] || fail "workspace source missing: $f"; done
}

validate_source

normalize_test_root(){ local candidate=$1 resolved; case "$candidate" in /*) ;; *) fail "--test-root must be an absolute path";; esac; install -d -m 700 "$candidate"; resolved=$(realpath -e "$candidate"); case "$resolved" in /|/home/dubrovin|/home/dubrovin/.openclaw|/home/dubrovin/.openclaw/*|/home/dubrovin/.local|/home/dubrovin/.local/*|/home/dubrovin/.config/systemd|/home/dubrovin/.config/systemd/*) fail "Refusing unsafe test root: $resolved";; esac; printf '%s\n' "$resolved"; }

run_isolated_install(){
  local test_root=$1; test_root=$(normalize_test_root "$test_root"); find "$test_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q . && fail "Isolated install requires an empty test root: $test_root"
  local openclaw_bin node_bin_dir isolated_path test_home state_dir config_path workspace agent_dir bin_dir taskctl_target contactctl_target contacts_lib_dir db_path agent_json health f workspace_files
  openclaw_bin=$(command -v openclaw || true); [ -n "$openclaw_bin" ] || openclaw_bin="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"; [ -x "$openclaw_bin" ] || fail "Unable to locate OpenClaw executable for isolated install"
  node_bin_dir=$(dirname "$(command -v node)"); isolated_path="$node_bin_dir:/usr/bin:/bin"; test_home="$test_root/home"; state_dir="$test_root/state"; config_path="$state_dir/openclaw.json"; workspace="$test_root/workspace-tasks"; agent_dir="$state_dir/agents/tasks/agent"; bin_dir="$test_root/bin"; taskctl_target="$bin_dir/taskctl"; contactctl_target="$bin_dir/contactctl"; contacts_lib_dir="$test_home/.local/lib/openclaw-contacts"; db_path="$state_dir/data/tasks/tasks.sqlite3"
  node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Unsupported Node runtime"
  test "$(env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow OPENCLAW_HOME="$test_home" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" --version|awk '{print $2}')" = "$EXPECTED_OPENCLAW_VERSION"
  node --check "$ROOT/taskctl"; bash "$ROOT/tests/smoke.sh" "$ROOT/taskctl"; bash "$ROOT/tests/batch4.sh"
  install -d -m 700 "$test_home" "$state_dir" "$workspace" "$agent_dir" "$bin_dir" "$(dirname "$db_path")" "$contacts_lib_dir"; install -m 600 "$CONTACTS_ROOT/core.cjs" "$contacts_lib_dir/core.cjs"; install -m 600 "$CONTACTS_ROOT/task-store.cjs" "$contacts_lib_dir/task-store.cjs"; install -m 700 "$CONTACTS_ROOT/contactctl" "$contactctl_target"; install -m 700 "$ROOT/taskctl" "$taskctl_target"
  for f in $TARGET_WORKSPACE_FILES; do install -m 644 "$ROOT/workspace/$f" "$workspace/$f"; done
  agent_json=$(node - "$ROOT/config/tasks-agent.fragment.json" "$workspace" "$agent_dir" <<'NODE'
const fs=require('fs'),a=JSON.parse(fs.readFileSync(process.argv[2]));delete a.id;a.workspace=process.argv[3];a.agentDir=process.argv[4];process.stdout.write(JSON.stringify(a));
NODE
); node - "$config_path" "$agent_json" <<'NODE'
const fs=require('fs'),a=JSON.parse(process.argv[3]);fs.writeFileSync(process.argv[2],JSON.stringify({tools:{profile:'coding',sessions:{visibility:'agent'}},agents:{ownership:'explicit',entries:{main:{},tasks:a,engineer:{tools:{allow:['read','write','edit','exec','process','apply_patch','progress_card']}}}}},null,2)+'\n');
NODE
  chmod 600 "$config_path"
  oc(){ env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow OPENCLAW_HOME="$test_home" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" "$@"; }
  oc config validate; oc plugins install "$CONTACTS_ARTIFACT" --force --accept-capabilities; oc plugins install "$ARTIFACT" --force --accept-capabilities; oc config set 'agents.entries.tasks.tools' "$TOOLS_JSON" --strict-json --dry-run; oc config set 'agents.entries.main.tools' "$MAIN_CONTACTS_TOOLS_JSON" --strict-json --dry-run; oc config set 'agents.entries.tasks.tools' "$TOOLS_JSON" --strict-json; oc config set 'agents.entries.main.tools' "$MAIN_CONTACTS_TOOLS_JSON" --strict-json; oc config validate
  env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" TASKCTL_CONTACTS_DB="$state_dir/data/contacts/contacts.sqlite3" "$taskctl_target" init >/dev/null
  health=$(env -i HOME="$test_home" PATH="$isolated_path" LANG=C.UTF-8 TZ=Europe/Moscow TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" TASKCTL_CONTACTS_DB="$state_dir/data/contacts/contacts.sqlite3" "$taskctl_target" health)
  node -e 'const h=JSON.parse(process.argv[1]),v=process.argv[2];if(h.implementation_version!==v||h.schema_version!==Number(process.argv[3]))process.exit(2)' "$health" "$TARGET_TASKCTL_VERSION" "$TARGET_SQLITE_SCHEMA"
  test "$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.version||""))' "$state_dir/extensions/taskctl/package.json")" = "$TARGET_PLUGIN_VERSION"
  contacts_inspect=$(oc plugins inspect contacts --runtime --json); node -e 'const x=JSON.parse(process.argv[1]),p=x?.plugin;if(p?.id!=="contacts"||p?.packageVersion!==process.argv[2]||p?.status!=="loaded"||p?.enabled!==true||p?.toolNames?.length!==Number(process.argv[3]))process.exit(1)' "$contacts_inspect" "$TARGET_CONTACTS_VERSION" "$TARGET_CONTACT_TOOL_COUNT"
  test "$(stat -c %a "$config_path")" = 600; test "$(stat -c %a "$taskctl_target")" = 700; test "$(stat -c %a "$contactctl_target")" = 700; test "$(stat -c %a "$contacts_lib_dir/core.cjs")" = 600; test "$(stat -c %a "$db_path")" = 600; test "$(stat -c %a "$state_dir/data/contacts/contacts.sqlite3")" = 600
  printf '\nTASK_AGENT_TEST_ROOT_DEPLOYED\n'
}

if [ "$#" -eq 2 ] && [ "$1" = --test-root ]; then run_isolated_install "$2"; exit 0; fi
[ "$#" -eq 0 ] || { echo "Usage: $0 [--test-root /absolute/path]" >&2; exit 2; }

node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Unsupported Node runtime"
test "$(openclaw --version|awk '{print $2}')" = "$EXPECTED_OPENCLAW_VERSION"
node --check "$ROOT/taskctl"; bash "$ROOT/tests/smoke.sh" "$ROOT/taskctl"; bash "$ROOT/tests/batch4.sh"
(cd "$ROOT/plugins/taskctl" && npm ci && npm test && npm run build && npm run plugin:build && npm run plugin:validate)
node -e "const c=require('/home/dubrovin/.openclaw/openclaw.json');if(!c?.agents?.entries?.tasks||!c?.agents?.entries?.main)process.exit(2)"
openclaw config set "agents.entries.tasks.tools" "$TOOLS_JSON" --strict-json --dry-run
openclaw config set "agents.entries.main.tools" "$MAIN_CONTACTS_TOOLS_JSON" --strict-json --dry-run
install -d -m 700 /home/dubrovin/.local/lib/openclaw-contacts
install -m 600 "$CONTACTS_ROOT/core.cjs" /home/dubrovin/.local/lib/openclaw-contacts/core.cjs
install -m 600 "$CONTACTS_ROOT/task-store.cjs" /home/dubrovin/.local/lib/openclaw-contacts/task-store.cjs
install -m 700 "$CONTACTS_ROOT/contactctl" /home/dubrovin/.local/bin/contactctl
install -m 700 "$ROOT/taskctl" /home/dubrovin/.local/bin/taskctl
for f in $TARGET_WORKSPACE_FILES; do install -m 644 "$ROOT/workspace/$f" "/home/dubrovin/.openclaw/workspace-tasks/$f"; done
openclaw plugins install "$CONTACTS_ARTIFACT" --force --accept-capabilities; openclaw plugins install "$ARTIFACT" --force --accept-capabilities; openclaw config set "agents.entries.tasks.tools" "$TOOLS_JSON" --strict-json; openclaw config set "agents.entries.main.tools" "$MAIN_CONTACTS_TOOLS_JSON" --strict-json
openclaw config validate
printf '\nTASK_AGENT_STAGE_DEPLOYED_RELOAD_REQUIRED\n'
