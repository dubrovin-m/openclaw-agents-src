#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(command -v node)
NODE_BIN_DIR=$(dirname "$NODE_BIN")
OPENCLAW_BIN=$(command -v openclaw || true)
[ -n "$OPENCLAW_BIN" ] || OPENCLAW_BIN="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"
[ -x "$OPENCLAW_BIN" ] || { echo "Unable to locate OpenClaw executable" >&2; exit 2; }
TARGET_TASKCTL_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.generation.taskctl_version))' "$ROOT/release.json")
TARGET_PLUGIN_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.plugin.version))' "$ROOT/release.json")
TARGET_SQLITE_SCHEMA=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.generation.sqlite_schema))' "$ROOT/release.json")
TARGET_TOOL_COUNT=$(node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.contracts.tools.length))' "$ROOT/plugins/taskctl/openclaw.plugin.json")
CONTACTS_ROOT="$ROOT/../../shared/contacts"
TARGET_CONTACTS_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.implementation_version))' "$CONTACTS_ROOT/release.json")
TARGET_CONTACT_TOOL_COUNT=$(node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.contracts.tools.length))' "$CONTACTS_ROOT/plugin/openclaw.plugin.json")
ISOLATED_PATH="$NODE_BIN_DIR:/usr/bin:/bin"
TEST_BASE=$(mktemp -d /tmp/task-agent-isolated-runtime.XXXXXX)
RUNTIME="$TEST_BASE/runtime"
TRACE_DIR="$TEST_BASE/trace"
BEFORE="$TEST_BASE/production.before"
AFTER="$TEST_BASE/production.after"
trap 'rm -rf "$TEST_BASE"' EXIT

fail() {
  echo "$*" >&2
  exit 2
}

tree_digest() {
  local dir=$1
  if [ ! -d "$dir" ]; then
    printf 'MISSING'
    return
  fi
  find "$dir" -type f -print0 | sort -z | xargs -0r sha256sum | sha256sum | awk '{print $1}'
}

resolve_host_openclaw_root() {
  local resolved dir pkg name version
  resolved=$(readlink -f "$OPENCLAW_BIN") || fail "Unable to resolve OpenClaw executable"
  dir=$(dirname "$resolved")
  while [ "$dir" != "/" ]; do
    pkg="$dir/package.json"
    if [ -f "$pkg" ]; then
      name=$(node -e "const p=require(process.argv[1]);process.stdout.write(String(p.name||''))" "$pkg")
      version=$(node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" "$pkg")
      if [ "$name" = "openclaw" ]; then
        [ "$version" = "2026.8.2" ] || fail "Unexpected host OpenClaw package version: $version"
        realpath -e "$dir"
        return
      fi
    fi
    dir=$(dirname "$dir")
  done
  fail "Unable to locate host OpenClaw package root"
}

snapshot_production() {
  local output=$1 path
  : > "$output"
  for path in \
    /home/dubrovin/.openclaw/openclaw.json \
    /home/dubrovin/.openclaw/data/tasks/tasks.sqlite3 \
    /home/dubrovin/.local/bin/taskctl \
    /home/dubrovin/.local/bin/contactctl \
    /home/dubrovin/.openclaw/data/contacts/contacts.sqlite3 \
    /home/dubrovin/.config/systemd/user/nexus-sync.service \
    /home/dubrovin/.config/systemd/user/openclaw-gateway.service \
    /home/dubrovin/.openclaw/workspace-tasks/AGENTS.md \
    /home/dubrovin/.openclaw/workspace-tasks/SOUL.md \
    /home/dubrovin/.openclaw/workspace-tasks/TOOLS.md \
    /home/dubrovin/.openclaw/workspace-tasks/USER.md \
    /home/dubrovin/.openclaw/workspace-tasks/IDENTITY.md \
    /home/dubrovin/.openclaw/workspace-tasks/HEARTBEAT.md; do
    if [ -f "$path" ]; then
      printf 'FILE\t%s\t%s\t%s\n' "$path" "$(stat -c '%a' "$path")" "$(sha256sum "$path" | awk '{print $1}')" >> "$output"
    else
      printf 'MISSING\t%s\n' "$path" >> "$output"
    fi
  done
  path=/home/dubrovin/.openclaw/extensions/taskctl
  printf 'DIR\t%s\t%s\n' "$path" "$(tree_digest "$path")" >> "$output"
  path=/home/dubrovin/.openclaw/extensions/contacts
  printf 'DIR\t%s\t%s\n' "$path" "$(tree_digest "$path")" >> "$output"
}

oc() {
  env -i \
    HOME="$RUNTIME/home" \
    PATH="$ISOLATED_PATH" \
    LANG="C.UTF-8" \
    TZ="Europe/Moscow" \
    OPENCLAW_HOME="$RUNTIME/home" \
    OPENCLAW_STATE_DIR="$RUNTIME/state" \
    OPENCLAW_CONFIG_PATH="$RUNTIME/state/openclaw.json" \
    "$OPENCLAW_BIN" "$@"
}

taskctl_test() {
  env -i \
    HOME="$RUNTIME/home" \
    PATH="$ISOLATED_PATH" \
    LANG="C.UTF-8" \
    TZ="Europe/Moscow" \
    TASKCTL_ALLOW_DB_OVERRIDE=1 \
    TASKCTL_DB="$RUNTIME/state/data/tasks/tasks.sqlite3" \
    TASKCTL_CONTACTS_DB="$RUNTIME/state/data/contacts/contacts.sqlite3" \
    "$RUNTIME/bin/taskctl" "$@"
}

run_with_trace() {
  local label=$1
  shift
  if command -v strace >/dev/null 2>&1; then
    install -d -m 700 "$TRACE_DIR"
    strace -ff -e trace=%file -o "$TRACE_DIR/$label" "$@"
  else
    "$@"
  fi
}

assert_no_production_trace() {
  local forbidden
  [ -d "$TRACE_DIR" ] || return
  for forbidden in \
    /home/dubrovin/.openclaw/openclaw.json \
    /home/dubrovin/.openclaw/data/tasks/tasks.sqlite3 \
    /home/dubrovin/.openclaw/extensions/taskctl \
    /home/dubrovin/.openclaw/extensions/contacts \
    /home/dubrovin/.openclaw/data/contacts/contacts.sqlite3 \
    /home/dubrovin/.local/bin/contactctl \
    /home/dubrovin/.openclaw/workspace-tasks \
    /home/dubrovin/.local/bin/taskctl \
    /home/dubrovin/.config/systemd/user/openclaw-gateway.service \
    /home/dubrovin/.config/systemd/user/nexus-sync.service; do
    if grep -R -F -q "$forbidden" "$TRACE_DIR"; then
      grep -R -F "$forbidden" "$TRACE_DIR" >&2 || true
      fail "Isolated execution accessed forbidden production state: $forbidden"
    fi
  done
}

snapshot_production "$BEFORE"

run_with_trace install bash "$ROOT/install.sh" --test-root "$RUNTIME"

test -f "$RUNTIME/state/openclaw.json"
test -x "$RUNTIME/bin/taskctl"
test -d "$RUNTIME/state/extensions/taskctl"
test -d "$RUNTIME/state/extensions/contacts"
test -x "$RUNTIME/bin/contactctl"
test -f "$RUNTIME/state/data/contacts/contacts.sqlite3"
test -d "$RUNTIME/workspace-tasks"
test "$(oc config get 'agents.entries.tasks.workspace' --json | jq -r .)" = "$RUNTIME/workspace-tasks"
test "$(oc config get 'agents.entries.tasks.agentDir' --json | jq -r .)" = "$RUNTIME/state/agents/tasks/agent"
oc config validate

taskctl_test health | jq -e --arg v "$TARGET_TASKCTL_VERSION" --argjson schema "$TARGET_SQLITE_SCHEMA" '.ok == true and .implementation_version == $v and .schema_version == $schema' >/dev/null
node -e 'const p=require(process.argv[1]),v=process.argv[2];if(p.version!==v)process.exit(2)' "$RUNTIME/state/extensions/taskctl/package.json" "$TARGET_PLUGIN_VERSION"
test "$(node -e "const p=require(process.argv[1]);process.stdout.write(p.version)" "$RUNTIME/state/extensions/taskctl/openclaw.plugin.json")" = "$TARGET_PLUGIN_VERSION"
node -e 'const p=require(process.argv[1]),v=process.argv[2];if(p.version!==v)process.exit(2)' "$RUNTIME/state/extensions/contacts/package.json" "$TARGET_CONTACTS_VERSION"
CONTACTS_HEALTH=$(HOME="$RUNTIME/home" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$RUNTIME/state/data/contacts/contacts.sqlite3" CONTACTCTL_PAYLOAD='{}' "$RUNTIME/bin/contactctl" health)
node -e 'const x=JSON.parse(process.argv[1]),v=process.argv[2];if(x.ok!==true||x.implementation_version!==v||x.integrity?.ok!==true)process.exit(1)' "$CONTACTS_HEALTH" "$TARGET_CONTACTS_VERSION"
cmp -s "$ROOT/workspace/AGENTS.md" "$RUNTIME/workspace-tasks/AGENTS.md" || fail "Deployed AGENTS.md differs from source"

oc plugins inspect taskctl --runtime --json | jq -e --arg v "$TARGET_PLUGIN_VERSION" --arg count "$TARGET_TOOL_COUNT" '
  .plugin.version == $v and
  (.plugin.toolNames as $names |
    (($names | length) == ($count|tonumber)) and
    (($names | index("taskctl")) == null) and
    (($names | index("task_production_control")) != null) and
    (["task_update", "task_complete", "task_cancel", "task_get", "inbox_add", "ref_resolve", "label_delete"] | all(.[]; . as $name | ($names | index($name)) != null))) and
  ([.tools[].names[]] as $names |
    (($names | unique | length) == ($count|tonumber)) and
    (($names | index("taskctl")) == null) and
    (($names | index("task_production_control")) != null) and
    (["task_update", "task_complete", "task_cancel", "task_get", "inbox_add", "ref_resolve", "label_delete"] | all(.[]; . as $name | ($names | index($name)) != null)))
' >/dev/null

oc plugins inspect contacts --runtime --json | jq -e --arg v "$TARGET_CONTACTS_VERSION" --arg count "$TARGET_CONTACT_TOOL_COUNT" '
  .plugin as $p | $p.toolNames as $names |
  $p.version == $v and $p.status == "loaded" and $p.enabled == true and
  ($names | length) == ($count|tonumber) and
  (["contact_search","contact_resolve","contact_get","contact_create","contact_update","contact_rename","contact_alias_add","contact_alias_remove","contact_merge"] | all(.[]; . as $name | ($names | index($name)) != null))
' >/dev/null

node --input-type=module - "$RUNTIME/state/extensions/contacts/dist/plugin.js" "$TARGET_CONTACT_TOOL_COUNT" <<'JS_CONTACT_ADMISSION'
import {pathToFileURL} from 'node:url';
const [pluginPath,countText]=process.argv.slice(2);const expectedCount=Number(countText);
const pluginModule=await import(pathToFileURL(pluginPath).href);
const registrations=[];const tools=[];
pluginModule.default.register({pluginConfig:{},registerTool(definition,options){
  registrations.push(options);
  const resolved=typeof definition==='function'?definition({}):definition;
  if(Array.isArray(resolved)) tools.push(...resolved); else if(resolved) tools.push(resolved);
}});
if(registrations.length!==expectedCount||registrations.some((options)=>options?.optional===true))process.exit(2);
if(tools.length!==expectedCount||tools.some((tool)=>tool.catalogMode!=='direct-only'))process.exit(2);
console.log('ISOLATED_CONTACT_DEFAULT_ADMISSION_PASS');
JS_CONTACT_ADMISSION

HOST_OPENCLAW_ROOT=$(resolve_host_openclaw_root)
node --input-type=module - "$RUNTIME/state/extensions/taskctl/dist/plugin.js" "$HOST_OPENCLAW_ROOT" "$TARGET_TOOL_COUNT" <<'JS_SCHEMA'
import {pathToFileURL} from 'node:url';
const [pluginPath,hostRoot,countText]=process.argv.slice(2);const expectedCount=Number(countText);
const pluginModule=await import(pathToFileURL(pluginPath).href);
const providerTools=await import(pathToFileURL(`${hostRoot}/dist/plugin-sdk/provider-tools.js`).href);
const toolPlugin=await import(pathToFileURL(`${hostRoot}/dist/plugin-sdk/tool-plugin.js`).href);
const metadata=toolPlugin.getToolPluginMetadata(pluginModule.default);
const tools=metadata?.tools??[];
const names=tools.map((tool)=>tool.name);
if(names.length!==expectedCount||new Set(names).size!==expectedCount||names.includes('taskctl')||!names.includes('task_production_control'))process.exit(2);
for(const name of ['task_update','task_complete','task_cancel','task_get','inbox_add','ref_resolve','label_delete','project_create','project_get','task_project_set'])if(!names.includes(name))process.exit(2);
const selected=tools.filter((tool)=>['task_get','inbox_add','ref_resolve','task_create','label_delete','project_create','project_get','task_project_set'].includes(tool.name));
const normalized=providerTools.normalizeOpenAIToolSchemas({
  tools:selected,
  provider:'openai',
  modelApi:'openai-responses',
  model:{provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',id:'gpt-5.6-luna'},
});
const byName=new Map(normalized.map((tool)=>[tool.name,tool.parameters]));
const taskGet=byName.get('task_get');
const inboxAdd=byName.get('inbox_add');
const refResolve=byName.get('ref_resolve');
const taskCreate=byName.get('task_create');
const labelDelete=byName.get('label_delete');
if(taskGet?.type!=='object'||JSON.stringify(Object.keys(taskGet?.properties??{}))!==JSON.stringify(['id'])||JSON.stringify(taskGet?.required)!==JSON.stringify(['id'])||taskGet?.additionalProperties!==false)process.exit(2);
if(inboxAdd?.type!=='object'||JSON.stringify(Object.keys(inboxAdd?.properties??{}).sort())!==JSON.stringify(['capture_key','content','operation_key'])||JSON.stringify([...(inboxAdd?.required??[])].sort())!==JSON.stringify(['capture_key','content','operation_key'])||inboxAdd?.additionalProperties!==false)process.exit(2);
if(refResolve?.type!=='object'||JSON.stringify(Object.keys(refResolve?.properties??{}).sort())!==JSON.stringify(['context','number'])||JSON.stringify(refResolve?.required)!==JSON.stringify(['number'])||refResolve?.additionalProperties!==false)process.exit(2);
if(taskCreate?.type!=='object'||JSON.stringify(Object.keys(taskCreate?.properties??{}).sort())!==JSON.stringify(['assignee','create_assignee','due_date','due_time','labels','operation_key','project_id','status','title'])||JSON.stringify([...(taskCreate?.required??[])].sort())!==JSON.stringify(['assignee','operation_key','title'])||taskCreate?.additionalProperties!==false||taskCreate?.allOf!==undefined)process.exit(2);
if(labelDelete?.type!=='object'||JSON.stringify(Object.keys(labelDelete?.properties??{}).sort())!==JSON.stringify(['id','operation_key'])||JSON.stringify([...(labelDelete?.required??[])].sort())!==JSON.stringify(['id','operation_key'])||labelDelete?.additionalProperties!==false)process.exit(2);
console.log('ISOLATED_EFFECTIVE_PER_ACTION_SCHEMA_PASS');
JS_SCHEMA

node --input-type=module - "$RUNTIME/state/extensions/taskctl/dist/index.js" <<'JS2'
import {pathToFileURL} from 'node:url';
const plugin=await import(pathToFileURL(process.argv[2]).href);
const valid=plugin.validateAndSanitizePayload('task_create',{operation_key:'runtime-valid',title:'Valid',assignee:'Дубровин М.',due_date:'2026-08-22'});
const validEmoji=plugin.validateAndSanitizePayload('label_set_emoji',{operation_key:'runtime-emoji',id:'L-1',emoji:'🏛'});
const validDelete=plugin.validateAndSanitizePayload('label_delete',{operation_key:'runtime-delete',id:'L-1'});
const invalidId=plugin.validateAndSanitizePayload('task_complete',{operation_key:'runtime-invalid',id:'I-1'});
const invalidDate=plugin.validateAndSanitizePayload('task_create',{operation_key:'runtime-invalid-date',title:'Bad date',assignee:'Дубровин М.',due_date:'2026-02-30'});
const invalidNested=plugin.validateAndSanitizePayload('inbox_commit',{operation_key:'runtime-invalid-nested',id:'I-1',tasks:[{title:'Bad',assignee:'Дубровин М.',unexpected:true}]});
let spawned=false;
const rejected=await plugin.executeTaskctl('task_complete',{operation_key:'runtime-invalid-exec',id:'I-1'},{spawnImpl:()=>{spawned=true;throw new Error('must not spawn');}});
if(!valid.ok||!validEmoji.ok||!validDelete.ok||invalidId.ok||invalidDate.ok||invalidNested.ok||rejected?.error?.code!=='TASKCTL_VALIDATION_ERROR'||spawned)process.exit(2);
JS2
test "$(stat -c '%a' "$RUNTIME/state/openclaw.json")" = "600"
test "$(stat -c '%a' "$RUNTIME/bin/taskctl")" = "700"
test "$(stat -c '%a' "$RUNTIME/bin/contactctl")" = "700"
test "$(stat -c '%a' "$RUNTIME/state/data/contacts/contacts.sqlite3")" = "600"
test "$(stat -c '%a' "$RUNTIME/state/data/tasks/tasks.sqlite3")" = "600"
for f in AGENTS.md SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md; do
  test "$(stat -c '%a' "$RUNTIME/workspace-tasks/$f")" = "644"
done

PEER_LINK="$RUNTIME/state/extensions/taskctl/node_modules/openclaw"
test -L "$PEER_LINK" || fail "Expected OpenClaw peer link was not created by plugin install"
test "$(readlink -f "$PEER_LINK")" = "$HOST_OPENCLAW_ROOT" || fail "Installed OpenClaw peer link target mismatch"

# Recovery qualification is intentionally predecessor-specific after the schema 5 boundary.
# Exact schema 4 predecessor recovery, including workspace retirement and post-mutation
# rollback, is exercised by workspace-retirement.sh and deploy.sh. This isolated harness
# remains focused on reconstructing and validating the exact target runtime without access
# to production state.
assert_no_production_trace
snapshot_production "$AFTER"
cmp -s "$BEFORE" "$AFTER" || { diff -u "$BEFORE" "$AFTER" >&2 || true; fail "Production artifacts changed during isolated target runtime test"; }

printf 'TRACE_EVIDENCE=%s\n' "$(command -v strace >/dev/null 2>&1 && printf used || printf unavailable)"
printf 'ISOLATED_TARGET_RUNTIME_PASS\n'
