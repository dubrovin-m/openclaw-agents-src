#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)

VALIDATION_TMP=$(mktemp -d "${TMPDIR:-/tmp}/task-agent-validate.XXXXXX")
cleanup_validation_tmp(){ rm -rf "$VALIDATION_TMP"; }
trap cleanup_validation_tmp EXIT INT TERM
mkdir -p "$VALIDATION_TMP/tmp" "$VALIDATION_TMP/node-compile-cache"
export TMPDIR="$VALIDATION_TMP/tmp"
export NODE_COMPILE_CACHE="$VALIDATION_TMP/node-compile-cache"
EXPECTED_OPENCLAW=$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.openclaw.version)' "$REPO_ROOT/runtime-contract.json")
test "$(openclaw --version | awk '{print $2}')" = "$EXPECTED_OPENCLAW"
openclaw config validate

node --check "$ROOT/taskctl"
bash -n "$ROOT/deploy.sh"
bash -n "$ROOT/recover.sh"
bash -n "$ROOT/install.sh"
bash -n "$ROOT/tests/deploy.sh"
bash -n "$ROOT/tests/smoke.sh"
bash -n "$ROOT/tests/batch4.sh"
bash -n "$ROOT/tests/batch5.sh"
bash -n "$ROOT/tests/batch6.sh"
bash -n "$ROOT/tests/batch7.sh"
bash -n "$ROOT/tests/batch8.sh"
bash -n "$ROOT/tests/batch9.sh"
bash -n "$ROOT/tests/recurrence-qualification.sh"
bash -n "$ROOT/tests/recurrence-gateway-e2e.sh"
bash -n "$ROOT/tests/reminders.sh"
bash -n "$ROOT/tests/deadline-governance.sh"
test -x "$ROOT/deploy.sh"
test -x "$ROOT/recover.sh"
test -x "$ROOT/install.sh"
test -x "$ROOT/tests/deploy.sh"
test -x "$ROOT/tests/batch4.sh"
test -x "$ROOT/tests/batch5.sh"

if grep -n -E 'nexus-sync|install\.sh' "$ROOT/deploy.sh"; then
  echo "Production deploy entrypoint must not modify shared nexus-sync or delegate to install.sh" >&2
  exit 1
fi
if grep -n -E 'nexus-sync|shared/nexus-sync' "$ROOT/install.sh"; then
  echo "Task Agent installer must not own shared Nexus synchronization" >&2
  exit 1
fi

node - "$ROOT/config/tasks-agent.fragment.json" "$ROOT/workspace" <<'NODE'
const fs=require('fs'),path=require('path');
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const workspace=process.argv[3];
const perFile=cfg.bootstrapMaxChars,total=cfg.bootstrapTotalMaxChars;
if(!Number.isSafeInteger(perFile)||perFile<1)throw new Error('Task Agent bootstrapMaxChars must be a positive integer');
if(!Number.isSafeInteger(total)||total<perFile)throw new Error('Task Agent bootstrapTotalMaxChars must be an integer >= bootstrapMaxChars');
const files=['AGENTS.md','SOUL.md','IDENTITY.md','USER.md','HEARTBEAT.md'];
const sizes=files.map(name=>[name,fs.readFileSync(path.join(workspace,name),'utf8').length]);
const oversized=sizes.filter(([,size])=>size>perFile);
if(oversized.length)throw new Error('Task Agent bootstrap file exceeds per-file injection budget: '+oversized.map(([name,size])=>name+'='+size).join(', '));
const aggregate=sizes.reduce((sum,[,size])=>sum+size,0);
if(aggregate>total)throw new Error('Task Agent bootstrap files exceed total injection budget: '+aggregate+' > '+total);
NODE

node - "$ROOT/plugins/taskctl/package.json" "$ROOT/plugins/taskctl/package-lock.json" "$ROOT/release.json" "$REPO_ROOT/runtime-contract.json" <<'NODE'
const fs=require('fs');
const pkg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const lock=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const release=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
const runtime=JSON.parse(fs.readFileSync(process.argv[5],'utf8'));
const tuple=v=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(v||'');return m?m.slice(1).map(Number):null};
const satisfies=(v,r)=>{const m=/^>=(\d+)\.(\d+)\.(\d+)$/.exec(r||''),x=tuple(v);if(!m||!x)return false;const f=m.slice(1).map(Number);return x[0]>f[0]||(x[0]===f[0]&&(x[1]>f[1]||(x[1]===f[1]&&x[2]>=f[2])))};
const root=lock.packages?.[''];
const typebox=lock.packages?.['node_modules/typebox'];
if(pkg.version!==release.plugin?.version||lock.version!==pkg.version||root?.version!==pkg.version)throw new Error('taskctl package/lock version must match the frozen release plugin version');
if(release.format!=='task-agent-release-v2')throw new Error('unsupported Task release format');
const build=release.generation?.openclaw_build_version,compat=release.generation?.openclaw_compat;
if(!tuple(build)||!satisfies(runtime?.openclaw?.version,compat))throw new Error('OpenClaw release compatibility invalid');
if(build!==pkg.devDependencies?.openclaw||build!==pkg.openclaw?.build?.openclawVersion||build!==root?.devDependencies?.openclaw)throw new Error('OpenClaw build identity mismatch');
if(compat!==pkg.peerDependencies?.openclaw||compat!==pkg.openclaw?.compat?.pluginApi||compat!==root?.peerDependencies?.openclaw)throw new Error('OpenClaw compatibility contract mismatch');
if(release.generation?.typebox_version!==pkg.dependencies?.typebox)throw new Error('TypeBox release identity mismatch');
if(pkg.dependencies?.typebox!=='1.3.15'||root?.dependencies?.typebox!=='1.3.15')throw new Error('root TypeBox dependency must be exactly 1.3.15');
if(typebox?.version!=='1.3.15'||typebox?.resolved!=='https://registry.npmjs.org/typebox/-/typebox-1.3.15.tgz'||typebox?.integrity!=='sha512-gOKAjLqUr+bFGbO5vxCEO5+nHh2wO+swzSIkiJJC0kJ4oLN6f65SrZn6tJYhsYO+qdnpf2NmlQwgsayYoi1NkQ==')throw new Error('resolved TypeBox identity drift');
NODE

RELEASE_ARTIFACT_REL=$(node -e 'const r=require(process.argv[1]);const p=r?.plugin?.artifact;if(typeof p!=="string"||!/^artifacts\/openclaw-plugin-taskctl-0\.4\.[0-9]+\.tgz$/.test(p))process.exit(2);process.stdout.write(p)' "$ROOT/release.json")
EXPECTED_ARTIFACT_SHA=$(node -e 'const r=require(process.argv[1]);const s=r?.plugin?.sha256;if(!/^[0-9a-f]{64}$/.test(s||""))process.exit(2);process.stdout.write(s)' "$ROOT/release.json")
ARTIFACT="$ROOT/$RELEASE_ARTIFACT_REL"
ARTIFACT_SHA_FILE="${ARTIFACT%.tgz}.sha256"
ARTIFACT_BASENAME=$(basename "$ARTIFACT")
ARTIFACT_SHA_BASENAME=$(basename "$ARTIFACT_SHA_FILE")
test -f "$ARTIFACT"
test -f "$ARTIFACT_SHA_FILE"
test "$(sha256sum "$ARTIFACT" | awk '{print $1}')" = "$EXPECTED_ARTIFACT_SHA"
test "$(awk 'NF{print $1;exit}' "$ARTIFACT_SHA_FILE")" = "$EXPECTED_ARTIFACT_SHA"
test "$(awk 'NF{print $2;exit}' "$ARTIFACT_SHA_FILE")" = "$ARTIFACT_BASENAME"
unexpected=$(find "$ROOT/artifacts" -maxdepth 1 -type f \( -name 'openclaw-plugin-taskctl-*.tgz' -o -name 'openclaw-plugin-taskctl-*.sha256' \) ! -name "$ARTIFACT_BASENAME" ! -name "$ARTIFACT_SHA_BASENAME" -print -quit)
if [ -n "$unexpected" ]; then
  echo "Superseded Task Agent release artifact retained in active tree: $unexpected" >&2
  exit 1
fi

init=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$(mktemp -u)/tasks.sqlite3" "$ROOT/taskctl" init)
node -e 'const x=JSON.parse(process.argv[1]);const r=require(process.argv[2]);if(x.implementation_version!==r.generation.taskctl_version||x.schema_version!==r.generation.sqlite_schema)process.exit(1)' "$init" "$ROOT/release.json"

bash "$ROOT/tests/smoke.sh" "$ROOT/taskctl"
bash "$ROOT/tests/batch4.sh"
bash "$ROOT/tests/batch6.sh" "$ROOT/taskctl"
bash "$ROOT/tests/batch7.sh" "$ROOT/taskctl"
bash "$ROOT/tests/batch8.sh" "$ROOT/taskctl"
bash "$ROOT/tests/batch9.sh" "$ROOT/taskctl"
bash "$ROOT/tests/recurrence-qualification.sh" "$ROOT/taskctl"
bash "$ROOT/tests/reminders.sh" "$ROOT/taskctl"
bash "$ROOT/tests/deadline-governance.sh"

PACK_DIR="$VALIDATION_TMP/plugin-pack"
mkdir -p "$PACK_DIR"
(
  cd "$ROOT/plugins/taskctl"
  npm ci
  npm test
  npm run build
  npm run plugin:build
  npm run plugin:check
  npm run plugin:validate
  npm pack --pack-destination "$PACK_DIR" >/dev/null
)
GENERATED_ARTIFACT="$PACK_DIR/$ARTIFACT_BASENAME"
test -f "$GENERATED_ARTIFACT"
test "$(sha256sum "$GENERATED_ARTIFACT" | awk '{print $1}')" = "$EXPECTED_ARTIFACT_SHA"
cmp -s "$GENERATED_ARTIFACT" "$ARTIFACT"
# Deployment/recovery source is validated after the current plugin artifact exists.
bash "$ROOT/tests/deploy.sh"
bash "$ROOT/tests/isolated-runtime.sh"
bash "$ROOT/tests/recurrence-gateway-e2e.sh"

cleanup_validation_tmp
trap - EXIT INT TERM
[ ! -e "$VALIDATION_TMP" ]
printf '\nTASK_AGENT_SOURCE_VALID\n'