#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
NODE_BIN_DIR=$(dirname "$(command -v node)")
TARGET_OPENCLAW_VERSION=$(node "$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs" openclaw-version "$REPO_ROOT/runtime-contract.json")
TMP=$(mktemp -d /tmp/task-reminder-gateway-e2e.XXXXXX)
TARGET_OPENCLAW_PREFIX=""
RUNTIME="$TMP/runtime"
GATEWAY_LOG="$TMP/gateway.log"
API_LOG="$TMP/telegram-api.log"
CAPTURE="$TMP/send-capture.jsonl"
GATEWAY_PID=""
API_PID=""
TOKEN="task-reminder-e2e-token"

fail(){
  echo "$*" >&2
  [ ! -f "$GATEWAY_LOG" ] || tail -120 "$GATEWAY_LOG" >&2 || true
  [ ! -f "$API_LOG" ] || tail -120 "$API_LOG" >&2 || true
  exit 2
}

stop_runtime_children(){
  local pids
  [ -n "$TARGET_OPENCLAW_PREFIX" ] || return 0
  pids=$(pgrep -f "$TARGET_OPENCLAW_PREFIX" 2>/dev/null || true)
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 40); do
    pids=$(pgrep -f "$TARGET_OPENCLAW_PREFIX" 2>/dev/null || true)
    [ -n "$pids" ] || return 0
    sleep 0.1
  done
  pids=$(pgrep -f "$TARGET_OPENCLAW_PREFIX" 2>/dev/null || true)
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
}

cleanup(){
  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  stop_runtime_children
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

OPENCLAW_BIN=$(command -v openclaw || true)
CURRENT_OPENCLAW_VERSION=""
if [ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]; then CURRENT_OPENCLAW_VERSION=$("$OPENCLAW_BIN" --version | awk '{print $2}') || true; fi
if [ "$CURRENT_OPENCLAW_VERSION" != "$TARGET_OPENCLAW_VERSION" ]; then
  command -v npm >/dev/null 2>&1 || fail "npm is required to qualify the exact OpenClaw target"
  TARGET_OPENCLAW_PREFIX="$TMP/openclaw-target"
  npm install --prefix "$TARGET_OPENCLAW_PREFIX" --no-save --package-lock=false "openclaw@$TARGET_OPENCLAW_VERSION" >/dev/null
  OPENCLAW_BIN="$TARGET_OPENCLAW_PREFIX/node_modules/.bin/openclaw"
fi
[ -x "$OPENCLAW_BIN" ] || fail "Unable to select exact OpenClaw target $TARGET_OPENCLAW_VERSION"
[ "$("$OPENCLAW_BIN" --version | awk '{print $2}')" = "$TARGET_OPENCLAW_VERSION" ] || fail "Reminder Gateway E2E selected the wrong OpenClaw version"
OPENCLAW_BIN_DIR=$(dirname "$OPENCLAW_BIN")
export PATH="$OPENCLAW_BIN_DIR:$PATH"
ISOLATED_PATH="$OPENCLAW_BIN_DIR:$NODE_BIN_DIR:/usr/bin:/bin"

free_port(){
  node - <<'NODE'
const net=require('node:net'),s=net.createServer();
s.unref();s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')process.exit(2);process.stdout.write(String(a.port));s.close();});
NODE
}
GATEWAY_PORT=$(free_port)
API_PORT=$(free_port)
[ "$GATEWAY_PORT" != "$API_PORT" ] || API_PORT=$(free_port)
GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT"
API_ROOT="http://127.0.0.1:$API_PORT"

cat >"$TMP/telegram-api.mjs" <<'NODE'
import fs from 'node:fs';
import http from 'node:http';
const port=Number(process.env.PORT),capture=process.env.CAPTURE;
const server=http.createServer((req,res)=>{
  let body='';req.setEncoding('utf8');req.on('data',c=>body+=c);req.on('end',()=>{
    const u=new URL(req.url,'http://127.0.0.1'),method=u.pathname.split('/').pop();
    let data={};try{data=JSON.parse(body||'{}')}catch{data=Object.fromEntries(new URLSearchParams(body))}
    const chat=String(data.chat_id??u.searchParams.get('chat_id')??'');
    const json=(code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
    if(method==='getMe')return json(200,{ok:true,result:{id:123456789,is_bot:true,first_name:'Synthetic',username:'synthetic_tasks_bot'}});
    if(method==='getUpdates')return json(200,{ok:true,result:[]});
    if(method==='deleteWebhook'||method==='setMyCommands'||method==='deleteMyCommands')return json(200,{ok:true,result:true});
    if(method==='getWebhookInfo')return json(200,{ok:true,result:{url:'',has_custom_certificate:false,pending_update_count:0}});
    if(method==='getChat')return json(200,{ok:true,result:{id:Number(chat)||111,type:'private',first_name:'Owner'}});
    if(method==='sendMessage'){
      fs.appendFileSync(capture,JSON.stringify({chat,text:String(data.text??'')})+'\n');
      const id=4000+(fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).length);
      return json(200,{ok:true,result:{message_id:id,date:0,chat:{id:Number(chat)||111,type:'private'},text:String(data.text??'')}});
    }
    return json(200,{ok:true,result:true});
  });
});
server.listen(port,'127.0.0.1',()=>process.stdout.write('READY\n'));
NODE
: >"$API_LOG"
PORT="$API_PORT" CAPTURE="$CAPTURE" node "$TMP/telegram-api.mjs" >"$API_LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 80); do
  grep -q READY "$API_LOG" 2>/dev/null && break
  kill -0 "$API_PID" 2>/dev/null || fail "synthetic Telegram API exited"
  sleep 0.05
done
grep -q READY "$API_LOG" || fail "synthetic Telegram API did not become ready"

TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 PATH="$OPENCLAW_BIN_DIR:$PATH" bash "$ROOT/install.sh" --test-root "$RUNTIME" >/dev/null
[ ! -e "$RUNTIME/home/.openclaw" ] && [ ! -L "$RUNTIME/home/.openclaw" ] || fail "isolated home already contains .openclaw"
ln -s "$RUNTIME/state" "$RUNTIME/home/.openclaw"

node - "$RUNTIME/state/openclaw.json" "$GATEWAY_PORT" "$TOKEN" "$API_ROOT" <<'NODE'
const fs=require('node:fs'),p=process.argv[2],port=Number(process.argv[3]),token=process.argv[4],apiRoot=process.argv[5],c=JSON.parse(fs.readFileSync(p,'utf8'));
c.gateway={mode:'local',port,bind:'loopback',auth:{mode:'token',token}};
c.channels??={};c.channels.telegram??={};c.channels.telegram.enabled=true;c.channels.telegram.accounts??={};
c.channels.telegram.accounts.tasks={enabled:true,botToken:'123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',apiRoot,dmPolicy:'allowlist',allowFrom:['111'],groupPolicy:'allowlist',groupAllowFrom:['111']};
c.bindings=(Array.isArray(c.bindings)?c.bindings:[]).filter(x=>!(x?.agentId==='tasks'&&x?.match?.channel==='telegram'&&x?.match?.accountId==='tasks'));
c.bindings.push({agentId:'tasks',match:{channel:'telegram',accountId:'tasks'}});
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE

oc_env(){
  env -i \
    HOME="$RUNTIME/home" \
    PATH="$ISOLATED_PATH" \
    LANG=C.UTF-8 \
    TZ=Europe/Moscow \
    OPENCLAW_HOME="$RUNTIME/home" \
    OPENCLAW_STATE_DIR="$RUNTIME/state" \
    OPENCLAW_CONFIG_PATH="$RUNTIME/state/openclaw.json" \
    OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" \
    OPENCLAW_GATEWAY_URL="$GATEWAY_URL" \
    OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
    OPENCLAW_SKIP_GMAIL_WATCHER=1 \
    OPENCLAW_SKIP_CANVAS_HOST=1 \
    OPENCLAW_SKIP_ACPX_RUNTIME=1 \
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 \
    "$@"
}
automation(){ oc_env "$OPENCLAW_BIN" automations "$@" --url "$GATEWAY_URL" --token "$TOKEN"; }

start_gateway(){
  : >"$GATEWAY_LOG"
  env -i \
    HOME="$RUNTIME/home" PATH="$ISOLATED_PATH" LANG=C.UTF-8 TZ=Europe/Moscow \
    OPENCLAW_HOME="$RUNTIME/home" OPENCLAW_STATE_DIR="$RUNTIME/state" OPENCLAW_CONFIG_PATH="$RUNTIME/state/openclaw.json" \
    OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" OPENCLAW_GATEWAY_URL="$GATEWAY_URL" OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 OPENCLAW_SKIP_GMAIL_WATCHER=1 OPENCLAW_SKIP_CANVAS_HOST=1 \
    OPENCLAW_SKIP_ACPX_RUNTIME=1 OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 \
    "$OPENCLAW_BIN" gateway run --bind loopback --port "$GATEWAY_PORT" --auth token --token "$TOKEN" >"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
  for _ in $(seq 1 160); do
    kill -0 "$GATEWAY_PID" 2>/dev/null || fail "isolated Gateway exited before readiness"
    automation status --json >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  fail "isolated Gateway did not become ready"
}
stop_gateway(){
  if [ -n "$GATEWAY_PID" ]; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
    GATEWAY_PID=""
  fi
  stop_runtime_children
}

oc_env "$OPENCLAW_BIN" config validate >/dev/null
HEALTH=$(oc_env "$RUNTIME/bin/taskctl" health)
read -r TARGET_TASKCTL TARGET_SCHEMA TARGET_PLUGIN <<<"$(node - "$ROOT/release.json" <<'NODE'
const r=require(process.argv[2]);process.stdout.write([r.generation.taskctl_version,r.generation.sqlite_schema,r.plugin.version].join(' '));
NODE
)"
node -e 'const h=JSON.parse(process.argv[1]);if(h.implementation_version!==process.argv[2]||h.schema_version!==Number(process.argv[3]))process.exit(1)' "$HEALTH" "$TARGET_TASKCTL" "$TARGET_SCHEMA" || fail "isolated taskctl generation mismatch"
[ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$RUNTIME/state/extensions/taskctl/package.json")" = "$TARGET_PLUGIN" ] || fail "frozen Task plugin version mismatch"

read -r DECLARATION NAME_B64 CRON_B64 TZ_NAME TIMEOUT <<<"$(node - "$ROOT/release.json" <<'NODE'
const r=require(process.argv[2]),m=r.reminder_dispatcher;if(m?.kind!=='openclaw-command-automation-v1')process.exit(2);
process.stdout.write([m.declaration_key,Buffer.from(m.name).toString('base64'),Buffer.from(m.cron).toString('base64'),m.timezone,m.timeout_seconds].join(' '));
NODE
)"
NAME=$(printf '%s' "$NAME_B64" | base64 -d)
CRON=$(printf '%s' "$CRON_B64" | base64 -d)
COMMAND_JSON=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1],"reminder-internal","dispatch-send"]))' "$RUNTIME/bin/taskctl")

create_due(){
  local key=$1 text=$2 trigger_date trigger_time create_now payload
  trigger_date=$(TZ=Europe/Moscow date -d '2 minutes ago' +%F)
  trigger_time=$(TZ=Europe/Moscow date -d '2 minutes ago' +%H:%M)
  create_now=$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
  payload=$(node -e 'process.stdout.write(JSON.stringify({operation_key:process.argv[1],text:process.argv[2],trigger_date:process.argv[3],trigger_time:process.argv[4]}))' "$key" "$text" "$trigger_date" "$trigger_time")
  oc_env env TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$RUNTIME/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$RUNTIME/state/data/contacts/contacts.sqlite3" TASKCTL_TEST_NOW="$create_now" TASKCTL_PAYLOAD="$payload" "$RUNTIME/bin/taskctl" reminder create
}

create_due direct-smoke 'Frozen direct smoke' >/dev/null
start_gateway
ADD=$(automation add --name "$NAME" --declaration-key "$DECLARATION" --cron "$CRON" --tz "$TZ_NAME" --exact --agent tasks --session isolated --command-argv "$COMMAND_JSON" --timeout-seconds "$TIMEOUT" --disabled --no-deliver --json)
JOB_ID=$(node - "$ADD" "$DECLARATION" "$COMMAND_JSON" "$TIMEOUT" <<'NODE'
const x=JSON.parse(process.argv[2]),key=process.argv[3],argv=JSON.parse(process.argv[4]),timeout=Number(process.argv[5]),j=x?.job;
if(x?.created!==true||typeof j?.id!=='string'||!j.id||j.declarationKey!==key||j.enabled!==false||j.payload?.kind!=='command'||JSON.stringify(j.payload.argv)!==JSON.stringify(argv)||j.payload.timeoutSeconds!==timeout||j.delivery?.mode!=='none'||j.scheduledToolPolicy!=null)process.exit(1);process.stdout.write(j.id);
NODE
) || fail "real OpenClaw did not create exact disabled Reminder command job"

set +e
DIRECT=$(oc_env "$RUNTIME/bin/taskctl" reminder-internal dispatch-send 2>&1)
DIRECT_RC=$?
set -e
[ "$DIRECT_RC" -eq 0 ] || fail "direct frozen Reminder smoke failed rc=$DIRECT_RC output=$DIRECT"
node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.count!==1||x.delivered!==1)process.exit(1)' "$DIRECT" || fail "direct frozen Reminder smoke did not confirm delivery: $DIRECT"
node - "$CAPTURE" <<'NODE' || fail "direct frozen Reminder smoke did not hit Telegram route"
const fs=require('node:fs'),rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);if(rows.length!==1||rows[0].chat!=='111'||rows[0].text!=='🔔 Напоминание: Frozen direct smoke')process.exit(1);
NODE

create_due automation-smoke 'Frozen automation smoke' >/dev/null
stop_gateway
start_gateway
LIST=$(automation list --all --json)
node - "$LIST" "$JOB_ID" "$DECLARATION" <<'NODE' || fail "disabled Reminder command job did not survive Gateway restart"
const x=JSON.parse(process.argv[2]),jobs=Array.isArray(x)?x:x.jobs,j=jobs?.find(v=>v.id===process.argv[3]);if(!j||j.declarationKey!==process.argv[4]||j.enabled!==false||j.payload?.kind!=='command'||j.delivery?.mode!=='none')process.exit(1);
NODE
automation edit "$JOB_ID" --enable --json >/dev/null
RUN=$(automation run "$JOB_ID" --wait --wait-timeout 60s --poll-interval 250ms)
node -e 'const x=JSON.parse(process.argv[1]);if(x.completed!==true||x.status!=="ok")process.exit(1)' "$RUN" || fail "real Reminder command Automation did not complete successfully"
automation edit "$JOB_ID" --disable --json >/dev/null

node - "$CAPTURE" "$RUNTIME/state/data/tasks/tasks.sqlite3" <<'NODE' || fail "real Reminder Automation delivery/settlement mismatch"
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),db=new DatabaseSync(process.argv[3],{readOnly:true});
try{
  if(rows.length!==2||rows[1].chat!=='111'||rows[1].text!=='🔔 Напоминание: Frozen automation smoke')process.exit(1);
  const rem=db.prepare("select status,close_reason,claim_token from reminders order by id").all();
  if(rem.length!==2||rem.some(r=>r.status!=='CLOSED'||r.close_reason!=='DELIVERED'||r.claim_token!==null))process.exit(1);
}finally{db.close();}
NODE

RUNS=$(automation runs --id "$JOB_ID" --limit 5)
node - "$RUNS" <<'NODE' || fail "real Automation history does not record successful Reminder command run"
const x=JSON.parse(process.argv[2]),entries=Array.isArray(x?.entries)?x.entries:[];if(!entries.some(e=>e.status==='ok'))process.exit(1);
NODE
automation rm "$JOB_ID" --json >/dev/null
LIST=$(automation list --all --json)
node - "$LIST" "$DECLARATION" <<'NODE' || fail "Reminder command declaration remains after isolated cleanup"
const x=JSON.parse(process.argv[2]),jobs=Array.isArray(x)?x:x.jobs;if(!Array.isArray(jobs)||jobs.some(j=>j.declarationKey===process.argv[3]))process.exit(1);
NODE

stop_gateway
printf 'TASK_AGENT_REMINDER_REAL_GATEWAY_PASS\n'
