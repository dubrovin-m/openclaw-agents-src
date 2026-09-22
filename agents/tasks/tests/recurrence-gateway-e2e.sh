#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
NODE_BIN_DIR=$(dirname "$(command -v node)")
TARGET_OPENCLAW_VERSION=$(node "$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs" openclaw-version "$REPO_ROOT/runtime-contract.json")
TMP=$(mktemp -d /tmp/task-recurrence-gateway-e2e.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
TARGET_OPENCLAW_PREFIX="$TMP/openclaw-target"
command -v npm >/dev/null 2>&1 || { echo "npm is required to qualify the exact OpenClaw target" >&2; exit 2; }
npm install --prefix "$TARGET_OPENCLAW_PREFIX" --no-save --package-lock=false "openclaw@$TARGET_OPENCLAW_VERSION" >/dev/null
OPENCLAW_BIN="$TARGET_OPENCLAW_PREFIX/node_modules/.bin/openclaw"
[ -x "$OPENCLAW_BIN" ] || { echo "Unable to install exact OpenClaw target $TARGET_OPENCLAW_VERSION" >&2; exit 2; }
OPENCLAW_BIN_DIR=$(dirname "$OPENCLAW_BIN")
export PATH="$OPENCLAW_BIN_DIR:$PATH"
ISOLATED_PATH="$OPENCLAW_BIN_DIR:$NODE_BIN_DIR:/usr/bin:/bin"
RUNTIME="$TMP/runtime"
GATEWAY_LOG="$TMP/gateway.log"
STATUS_JSON="$TMP/status.json"
GATEWAY_PID=""
TOKEN="task-recurrence-e2e-$(date +%s)-$"

fail(){
  echo "$*" >&2
  [ ! -f "$GATEWAY_LOG" ] || tail -120 "$GATEWAY_LOG" >&2 || true
  exit 2
}

cleanup(){
  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

PORT=$(node - <<'NODE'
const net=require('node:net');
const server=net.createServer();
server.unref();
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  if(!address||typeof address==='string')process.exit(2);
  process.stdout.write(String(address.port));
  server.close();
});
NODE
)
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "unable to allocate isolated Gateway port"
GATEWAY_URL="ws://127.0.0.1:$PORT"

oc_env(){
  env -i \
    HOME="$RUNTIME/home" \
    PATH="$ISOLATED_PATH" \
    LANG=C.UTF-8 \
    TZ=Europe/Moscow \
    OPENCLAW_HOME="$RUNTIME/home" \
    OPENCLAW_STATE_DIR="$RUNTIME/state" \
    OPENCLAW_CONFIG_PATH="$RUNTIME/state/openclaw.json" \
    OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
    OPENCLAW_SKIP_CHANNELS=1 \
    OPENCLAW_SKIP_GMAIL_WATCHER=1 \
    OPENCLAW_SKIP_CANVAS_HOST=1 \
    OPENCLAW_SKIP_ACPX_RUNTIME=1 \
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 \
    "$@"
}

automation(){
  oc_env "$OPENCLAW_BIN" automations "$@" --url "$GATEWAY_URL" --token "$TOKEN"
}

start_gateway(){
  : > "$GATEWAY_LOG"
  oc_env "$OPENCLAW_BIN" gateway run \
    --allow-unconfigured \
    --bind loopback \
    --port "$PORT" \
    --auth token \
    --token "$TOKEN" >"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
  for _ in $(seq 1 160); do
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      fail "isolated Gateway exited before readiness"
    fi
    if automation status --json >"$STATUS_JSON" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  fail "isolated Gateway did not become ready"
}

stop_gateway(){
  [ -n "$GATEWAY_PID" ] || return 0
  kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  GATEWAY_PID=""
}

TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$ROOT/install.sh" --test-root "$RUNTIME" >/dev/null

# The production taskctl resolves ~/.openclaw directly. Mirror the production
# home layout inside the disposable root so the command Automation executes the
# exact no-override taskctl path used in production.
[ ! -e "$RUNTIME/home/.openclaw" ] && [ ! -L "$RUNTIME/home/.openclaw" ] || fail "isolated home already contains .openclaw"
ln -s "$RUNTIME/state" "$RUNTIME/home/.openclaw"

DEFAULT_HEALTH=$(oc_env "$RUNTIME/bin/taskctl" health)
node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.implementation_version!=="0.4.11"||x.schema_version!==8)process.exit(1)' "$DEFAULT_HEALTH" || fail "default taskctl path does not resolve isolated schema 8 store"

TODAY=$(TZ=Europe/Moscow date +%F)
YESTERDAY=$(node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");d.setUTCDate(d.getUTCDate()-1);process.stdout.write(d.toISOString().slice(0,10))' "$TODAY")
PINNED_NOW="${YESTERDAY}T08:00:00Z"
SELF=$(oc_env env TASKCTL_PAYLOAD='{}' "$RUNTIME/bin/taskctl" person list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s),p=x.people.find(v=>v.display_name==="Дубровин М.");if(!p)process.exit(1);process.stdout.write(p.id)})')
CREATE_PAYLOAD=$(node -e 'process.stdout.write(JSON.stringify({operation_key:"gateway-e2e-create",mode:"CALENDAR",rule:{kind:"DAYS",interval:1,start_date:process.argv[1]},title:"Gateway materializer proof",assignee_id:process.argv[2]}))' "$YESTERDAY" "$SELF")
CREATED=$(oc_env env TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_TEST_NOW="$PINNED_NOW" TASKCTL_PAYLOAD="$CREATE_PAYLOAD" "$RUNTIME/bin/taskctl" recurrence create)
RID=$(node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.recurrence?.mode!=="CALENDAR"||!x.first_occurrence)process.exit(1);process.stdout.write(x.recurrence.id)' "$CREATED")

node - "$RUNTIME/state/data/tasks/tasks.sqlite3" "$RID" "$YESTERDAY" <<'NODE' || fail "pre-Gateway Recurrence fixture is invalid"
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const rid=Number(process.argv[3].slice(2));
  const rows=db.prepare('select occurrence_date from recurrence_occurrences where recurrence_id=? order by occurrence_date').all(rid);
  if(rows.length!==1||rows[0].occurrence_date!==process.argv[4])process.exit(1);
} finally { db.close(); }
NODE

read -r DECLARATION NAME CRON TZ_NAME TIMEOUT <<<"$(node - "$ROOT/release.json" <<'NODE'
const r=require(process.argv[2]),m=r.calendar_materializer;
if(m?.kind!=="openclaw-command-automation-v1")process.exit(2);
process.stdout.write([m.declaration_key,Buffer.from(m.name).toString('base64'),Buffer.from(m.cron).toString('base64'),m.timezone,m.timeout_seconds].join(' '));
NODE
)"
NAME=$(printf '%s' "$NAME" | base64 -d)
CRON=$(printf '%s' "$CRON" | base64 -d)
COMMAND_JSON=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1],"recurrence","materialize"]))' "$RUNTIME/bin/taskctl")

start_gateway
ADD=$(automation add \
  --name "$NAME" \
  --declaration-key "$DECLARATION" \
  --cron "$CRON" \
  --tz "$TZ_NAME" \
  --exact \
  --agent tasks \
  --session isolated \
  --command-argv "$COMMAND_JSON" \
  --timeout-seconds "$TIMEOUT" \
  --no-deliver \
  --json)
JOB_ID=$(node - "$ADD" "$DECLARATION" "$NAME" "$CRON" "$TZ_NAME" "$TIMEOUT" "$COMMAND_JSON" <<'NODE'
const x=JSON.parse(process.argv[2]),key=process.argv[3],name=process.argv[4],expr=process.argv[5],tz=process.argv[6],timeout=Number(process.argv[7]),argv=JSON.parse(process.argv[8]),j=x?.job;
if(x?.created!==true||typeof j?.id!=="string"||!j.id||j.declarationKey!==key||j.name!==name||j.enabled!==true||j.agentId!=="tasks"||j.schedule?.kind!=="cron"||j.schedule?.expr!==expr||j.schedule?.tz!==tz||(j.schedule?.staggerMs??0)!==0||j.sessionTarget!=="isolated"||j.payload?.kind!=="command"||JSON.stringify(j.payload?.argv)!==JSON.stringify(argv)||j.payload?.timeoutSeconds!==timeout||j.delivery?.mode!=="none")process.exit(1);
process.stdout.write(j.id);
NODE
) || fail "real OpenClaw declarative add response does not match release materializer contract"

LIST=$(automation list --all --json)
node - "$LIST" "$JOB_ID" "$DECLARATION" <<'NODE' || fail "real OpenClaw list does not preserve materializer declaration"
const x=JSON.parse(process.argv[2]),jobs=Array.isArray(x)?x:x.jobs;if(!Array.isArray(jobs))process.exit(1);const j=jobs.find(v=>v.id===process.argv[3]);if(!j||j.declarationKey!==process.argv[4])process.exit(1);
NODE

# Prove scheduler state survives a real Gateway restart before execution.
stop_gateway
start_gateway
LIST=$(automation list --all --json)
node - "$LIST" "$JOB_ID" "$DECLARATION" <<'NODE' || fail "materializer declaration did not survive Gateway restart"
const x=JSON.parse(process.argv[2]),jobs=Array.isArray(x)?x:x.jobs;if(!Array.isArray(jobs)||!jobs.some(j=>j.id===process.argv[3]&&j.declarationKey===process.argv[4]))process.exit(1);
NODE

RUN1=$(automation run "$JOB_ID" --wait --wait-timeout 60s --poll-interval 250ms)
node -e 'const x=JSON.parse(process.argv[1]);if(x.completed!==true||x.status!=="ok")process.exit(1)' "$RUN1" || fail "first real Automation run did not complete successfully"

node - "$RUNTIME/state/data/tasks/tasks.sqlite3" "$RID" "$YESTERDAY" "$TODAY" <<'NODE' || fail "real Automation did not materialize the current Moscow slot"
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{const rid=Number(process.argv[3].slice(2)),rows=db.prepare('select occurrence_date from recurrence_occurrences where recurrence_id=? order by occurrence_date').all(rid).map(r=>r.occurrence_date);if(JSON.stringify(rows)!==JSON.stringify([process.argv[4],process.argv[5]]))process.exit(1);}finally{db.close();}
NODE

# Replay the same provider job: occurrence identity must suppress duplicates.
RUN2=$(automation run "$JOB_ID" --wait --wait-timeout 60s --poll-interval 250ms)
node -e 'const x=JSON.parse(process.argv[1]);if(x.completed!==true||x.status!=="ok")process.exit(1)' "$RUN2" || fail "replayed real Automation run did not complete successfully"
node - "$RUNTIME/state/data/tasks/tasks.sqlite3" "$RID" <<'NODE' || fail "Automation replay duplicated a Recurrence occurrence"
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});try{const rid=Number(process.argv[3].slice(2));if(db.prepare('select count(*) n from recurrence_occurrences where recurrence_id=?').get(rid).n!==2)process.exit(1);}finally{db.close();}
NODE

RUNS=$(automation runs --id "$JOB_ID" --limit 5)
node - "$RUNS" <<'NODE' || fail "real Automation run history does not contain two successful command executions"
const x=JSON.parse(process.argv[2]),entries=Array.isArray(x?.entries)?x.entries:[];if(entries.filter(e=>e.status==='ok').length<2)process.exit(1);
NODE

REMOVED=$(automation rm "$JOB_ID" --json)
node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true)process.exit(1)' "$REMOVED" || fail "real Automation removal failed"
LIST=$(automation list --all --json)
node - "$LIST" "$DECLARATION" <<'NODE' || fail "materializer declaration remains after removal"
const x=JSON.parse(process.argv[2]),jobs=Array.isArray(x)?x:x.jobs;if(!Array.isArray(jobs)||jobs.some(j=>j.declarationKey===process.argv[3]))process.exit(1);
NODE

stop_gateway
printf 'TASK_AGENT_RECURRENCE_REAL_GATEWAY_PASS\n'
