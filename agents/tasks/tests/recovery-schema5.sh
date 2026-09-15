#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
read -r BASE_SHA WORKSPACE_SHA BASE_TASKCTL_VERSION EXPECTED_BASE_PLUGIN < <(node - "$ROOT/release.json" <<'NODE'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const source=r?.from?.source_revision;
const workspaceSource=r?.from?.workspace_source_revision??source;
const taskctl=r?.from?.taskctl_versions;
const plugins=r?.from?.plugin_versions;
if(!/^[0-9a-f]{40}$/.test(source||'')||!/^[0-9a-f]{40}$/.test(workspaceSource||'')||!Array.isArray(taskctl)||taskctl.length!==1||!/^0\.4\.\d+$/.test(taskctl[0]||'')||!Array.isArray(plugins)||plugins.length!==1||!/^0\.4\.\d+$/.test(plugins[0]||''))process.exit(2);
process.stdout.write(`${source} ${workspaceSource} ${taskctl[0]} ${plugins[0]}\n`);
NODE
)
OPENCLAW_VERSION=$(node "$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs" openclaw-version "$REPO_ROOT/runtime-contract.json")
TMP=$(mktemp -d /tmp/task-agent-recovery-schema5.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
R="$TMP/runtime"
PREDECESSOR_TOOLS="$TMP/predecessor-tools.json"

mkdir -p \
  "$R/home" \
  "$R/state/extensions/taskctl/node_modules/typebox" \
  "$R/state/extensions/taskctl/node_modules" \
  "$R/state/data/tasks" \
  "$R/state/backups/tools-md-migration" \
  "$R/workspace-tasks" \
  "$R/bin" \
  "$R/backups" \
  "$R/deliverables" \
  "$TMP/shims" \
  "$TMP/openclaw-package"

printf '{"name":"openclaw","version":"%s"}\n' "$OPENCLAW_VERSION" > "$TMP/openclaw-package/package.json"

cat > "$TMP/shims/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
STATE=${OPENCLAW_STATE_DIR:?}
CONFIG=${OPENCLAW_CONFIG_PATH:?}
SOURCE=${TASK_AGENT_TEST_SOURCE_ROOT:?}
if [ "${1:-}" = "--version" ]; then echo "openclaw ${TASK_AGENT_TEST_OPENCLAW_VERSION:?}"; exit 0; fi
if [ "${1:-}" = config ] && [ "${2:-}" = validate ]; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CONFIG"
  exit 0
fi
if [ "${1:-}" = config ] && [ "${2:-}" = set ]; then
  path=$3; value=$4
  if [[ " $* " == *' --dry-run '* ]]; then node -e 'JSON.parse(process.argv[1])' "$value"; exit 0; fi
  node - "$CONFIG" "$path" "$value" <<'NODE'
const fs=require('fs'),p=process.argv[2],path=process.argv[3];
if(path!=='agents.entries.tasks.tools')process.exit(2);
const c=JSON.parse(fs.readFileSync(p,'utf8'));
if(!c.agents?.entries?.tasks)process.exit(2);
c.agents.entries.tasks.tools=JSON.parse(process.argv[4]);
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');
NODE
  exit 0
fi
if [ "${1:-}" = plugins ] && [ "${2:-}" = install ]; then
  art=$3
  d="$STATE/extensions/taskctl"
  t=$(mktemp -d)
  rm -rf "$d"
  mkdir -p "$d"
  tar -xzf "$art" -C "$t"
  cp -a "$t/package/." "$d/"
  rm -rf "$t"
  mkdir -p "$d/node_modules/typebox"
  printf '{"name":"typebox","version":"1.3.15"}\n' > "$d/node_modules/typebox/package.json"
  exit 0
fi
if [ "${1:-}" = plugins ] && [ "${2:-}" = inspect ]; then
  node - "$SOURCE/plugins/taskctl/openclaw.plugin.json" <<'NODE'
const fs=require('fs'),m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(JSON.stringify({plugin:{id:'taskctl'},tools:m.contracts.tools})+'\n');
NODE
  exit 0
fi
if [ "${1:-}" = automations ] && [ "${2:-}" = list ]; then
  f="$STATE/automations-test.json"; [ -f "$f" ] || printf '{"jobs":[]}\n' > "$f"; cat "$f"; exit 0
fi
if [ "${1:-}" = automations ] && [ "${2:-}" = add ]; then
  node - "$STATE/automations-test.json" "${@:3}" <<'NODE'
const fs=require('fs'),p=process.argv[2],a=process.argv.slice(3),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};const job={id:'recurrence-job-1',declarationKey:opt('--declaration-key'),name:opt('--name'),enabled:true,agentId:opt('--agent'),schedule:{kind:'cron',expr:opt('--cron'),tz:opt('--tz'),staggerMs:a.includes('--exact')?0:undefined},sessionTarget:opt('--session')||'isolated',wakeMode:'now',payload:{kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))},delivery:{mode:a.includes('--no-deliver')?'none':'announce'}};fs.writeFileSync(p,JSON.stringify({jobs:[job]})+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
  exit 0
fi
if [ "${1:-}" = automations ] && { [ "${2:-}" = rm ] || [ "${2:-}" = remove ]; }; then
  node - "$STATE/automations-test.json" "$3" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8'));x.jobs=(x.jobs||[]).filter(j=>j.id!==id);fs.writeFileSync(p,JSON.stringify(x)+'\n');process.stdout.write(JSON.stringify({ok:true,removed:true})+'\n');
NODE
  exit 0
fi
exit 2
SH
chmod 755 "$TMP/shims/openclaw"

cat > "$TMP/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
R=${TASK_AGENT_TEST_ROOT:?}
[ "${1:-}" = --user ] && shift
case "$1" in
  stop) echo inactive > "$R/gateway.state"; echo stop >> "$R/gateway.counts" ;;
  start) echo active > "$R/gateway.state"; echo start >> "$R/gateway.counts" ;;
  is-active) [ "${2:-}" = --quiet ] && shift; [ "$(cat "$R/gateway.state")" = active ] || exit 3 ;;
  *) exit 2 ;;
esac
SH
chmod 755 "$TMP/shims/systemctl"

export PATH="$TMP/shims:$(dirname "$(command -v node)"):/usr/bin:/bin"
export TASK_AGENT_TEST_OPENCLAW_VERSION="$OPENCLAW_VERSION"
export TASK_AGENT_TEST_OPENCLAW_ROOT="$TMP/openclaw-package"
export TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$REPO_ROOT"
export TASK_AGENT_TEST_SOURCE_ROOT="$ROOT"

# Exact release-declared production predecessor identities.
git -C "$REPO_ROOT" cat-file -e "$BASE_SHA^{commit}"
git -C "$REPO_ROOT" cat-file -e "$WORKSPACE_SHA^{commit}"
git -C "$REPO_ROOT" show "$BASE_SHA:agents/tasks/taskctl" > "$R/bin/taskctl"
chmod 700 "$R/bin/taskctl"
git -C "$REPO_ROOT" show "$BASE_SHA:agents/tasks/plugins/taskctl/package.json" > "$R/state/extensions/taskctl/package.json"
git -C "$REPO_ROOT" show "$BASE_SHA:agents/tasks/config/tasks-tools.json" > "$PREDECESSOR_TOOLS"
printf '{"name":"typebox","version":"1.3.15"}\n' > "$R/state/extensions/taskctl/node_modules/typebox/package.json"
ln -s "$TMP/openclaw-package" "$R/state/extensions/taskctl/node_modules/openclaw"

node - "$R/state/openclaw.json" "$PREDECESSOR_TOOLS" <<'NODE'
const fs=require('fs');
const tools=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const config={agents:{entries:{tasks:{tools}}},plugins:{entries:{taskctl:{}},installs:{taskctl:{}}}};
fs.writeFileSync(process.argv[2],JSON.stringify(config,null,2)+'\n');
NODE
chmod 600 "$R/state/openclaw.json"

for f in AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md; do
  git -C "$REPO_ROOT" show "$WORKSPACE_SHA:agents/tasks/workspace/$f" > "$R/workspace-tasks/$f"
  chmod 644 "$R/workspace-tasks/$f"
done
TOOLS_SHA=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.workspace_sha256["TOOLS.md"])' "$ROOT/release.json")
git -C "$REPO_ROOT" show "$WORKSPACE_SHA:agents/tasks/workspace/TOOLS.md" > "$R/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"
chmod 600 "$R/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"

TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$R/state/data/tasks/tasks.sqlite3" node "$R/bin/taskctl" init >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$R/state/data/tasks/tasks.sqlite3" TASKCTL_PAYLOAD='{"operation_key":"schema5-recovery-fixture","title":"Preserve schema 5 row","assignee":"Дубровин М."}' node "$R/bin/taskctl" task create >/dev/null
chmod 600 "$R/state/data/tasks/tasks.sqlite3"
echo active > "$R/gateway.state"
: > "$R/gateway.counts"
printf '{"jobs":[]}\n' > "$R/state/automations-test.json"

logical_db_fingerprint(){
  node - "$1" <<'NODE'
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const tables=d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const state={
    user_version:Number(d.prepare('PRAGMA user_version').get().user_version),
    integrity:d.prepare('PRAGMA integrity_check').get().integrity_check,
    fk:d.prepare('PRAGMA foreign_key_check').all(),
    schema:tables,
    data:Object.fromEntries(tables.filter(x=>x.type==='table').map(({name})=>{
      const q='"'+String(name).replaceAll('"','""')+'"';
      return [name,d.prepare(`SELECT * FROM ${q} ORDER BY rowid`).all()];
    }))
  };
  process.stdout.write(createHash('sha256').update(JSON.stringify(state)).digest('hex'));
} finally {d.close();}
NODE
}

BASE_DB=$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")
BASE_PLUGIN=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")
[ "$BASE_PLUGIN" = "$EXPECTED_BASE_PLUGIN" ]

set +e
HOME="$R/home" TASK_AGENT_DEPLOY_FAULT=after-install "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || { echo "expected proven rollback exit 1, got $CODE" >&2; exit 1; }

HEALTH=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$R/state/data/tasks/tasks.sqlite3" "$R/bin/taskctl" health)
node -e 'const h=JSON.parse(process.argv[1]);if(h.implementation_version!==process.argv[2]||h.schema_version!==5)process.exit(1)' "$HEALTH" "$BASE_TASKCTL_VERSION"
[ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = "$EXPECTED_BASE_PLUGIN" ]
[ "$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")" = "$BASE_DB" ]
[ "$(cat "$R/gateway.state")" = active ]

RESULT=$(find "$R/deliverables" -maxdepth 1 -type f -name '*-result.json' -print -quit)
[ -n "$RESULT" ]
node - "$RESULT" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(r.result!=='ROLLED_BACK'||r.rollback_count!==1||r.mutation_started!==true)process.exit(1);
NODE

# The provider-clock mutation is the last activation step; a fault there must also prove exact predecessor rollback.
set +e
HOME="$R/home" TASK_AGENT_DEPLOY_FAULT=after-calendar-materializer "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || { echo "expected post-Automation proven rollback exit 1, got $CODE" >&2; exit 1; }
node - "$R/state/automations-test.json" <<'NODE'
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if((x.jobs||[]).length!==0)process.exit(1);
NODE
HEALTH=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$R/state/data/tasks/tasks.sqlite3" "$R/bin/taskctl" health)
node -e 'const h=JSON.parse(process.argv[1]);if(h.implementation_version!==process.argv[2]||h.schema_version!==5)process.exit(1)' "$HEALTH" "$BASE_TASKCTL_VERSION"
[ "$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")" = "$BASE_DB" ]

printf 'TASK_AGENT_SCHEMA5_RECOVERY_ROLLBACK_PASS\n'
