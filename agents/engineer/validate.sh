#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
RUNTIME_CONTRACT="$REPO_ROOT/runtime-contract.json"
RUNTIME_HELPER="$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs"

fail() {
  echo "Engineer validation failed: $*" >&2
  exit 2
}

for path in \
  "$ROOT/README.md" \
  "$ROOT/config/engineer-agent.fragment.json" \
  "$ROOT/config/engineer-tools.json" \
  "$ROOT/bin/engineer-vps-maintenance-snapshot" \
  "$ROOT/tests/maintenance_snapshot_test.py" \
  "$ROOT/workspace/AGENTS.md" \
  "$ROOT/workspace/SOUL.md" \
  "$ROOT/workspace/IDENTITY.md" \
  "$ROOT/workspace/USER.md" \
  "$ROOT/workspace/TOOLS.md" \
  "$ROOT/workspace/HEARTBEAT.md" \
  "$RUNTIME_CONTRACT" \
  "$RUNTIME_HELPER"
do
  [ -f "$path" ] || fail "missing required source: $path"
done

[ ! -e "$ROOT/workspace/MEMORY.md" ] || fail "v0 must not ship persistent agent memory"
[ ! -e "$ROOT/workspace/BOOTSTRAP.md" ] || fail "v0 must not ship an interactive bootstrap ritual"

node "$RUNTIME_HELPER" repo-check "$REPO_ROOT" >/dev/null || fail "repository runtime contract mismatch"

python3 -m py_compile "$ROOT/bin/engineer-vps-maintenance-snapshot" || fail "maintenance collector syntax invalid"
python3 -m unittest "$ROOT/tests/maintenance_snapshot_test.py" >/dev/null || fail "maintenance collector tests failed"

python3 - "$ROOT/bin/engineer-vps-maintenance-snapshot" <<'PYVALIDATE' || exit 2
import ast
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
tree = ast.parse(source)

for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess" and node.func.attr == "run":
            for kw in node.keywords:
                if kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                    raise SystemExit("Engineer validation failed: maintenance collector must not use shell=True")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if isinstance(node.func.value, ast.Name) and node.func.value.id in {"os", "shutil"} and node.func.attr in {"remove", "unlink", "rmtree"}:
            raise SystemExit(f"Engineer validation failed: mutating filesystem call is forbidden: {node.func.value.id}.{node.func.attr}")
PYVALIDATE

node - "$ROOT/config/engineer-agent.fragment.json" "$ROOT/config/engineer-tools.json" <<'NODE' || exit 2
const fs = require('node:fs');

const fail = (message) => {
  console.error(`Engineer validation failed: ${message}`);
  process.exit(2);
};

const agent = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tools = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

if (agent.id !== 'engineer') fail('agent id must be engineer');
if (agent.workspace !== '/home/dubrovin/.openclaw/workspace-engineer') fail('unexpected workspace path');
if (agent.agentDir !== '/home/dubrovin/.openclaw/agents/engineer/agent') fail('unexpected agentDir path');
if (!Array.isArray(agent.skills) || agent.skills.length !== 0) fail('Engineer v0 must not inherit or expose skills');
if ('model' in agent || 'auth' in agent || 'bindings' in agent) fail('model, auth, and channel bindings are runtime/provider state, not package defaults');

if (tools.profile !== 'full') fail('tool profile must use explicit allow/deny policy');
const allow = new Set(tools.allow ?? []);
const expectedAllow = new Set(['read', 'exec', 'process']);
if (allow.size !== expectedAllow.size || [...expectedAllow].some((name) => !allow.has(name))) {
  fail('allowed tool surface must be exactly read, exec, process');
}

const requiredDeny = [
  'write', 'edit', 'apply_patch',
  'browser', 'gateway', 'cron', 'web_search', 'web_fetch',
  'sessions', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn',
  'subagents', 'nodes', 'computer', 'canvas'
];
const deny = new Set(tools.deny ?? []);
for (const name of requiredDeny) {
  if (!deny.has(name)) fail(`required denied tool missing: ${name}`);
}
for (const name of allow) {
  if (deny.has(name)) fail(`tool appears in both allow and deny: ${name}`);
}

if (tools.fs?.workspaceOnly !== true) fail('filesystem reads must remain workspace-only');
if (tools.exec?.host !== 'gateway') fail('exec host must be gateway');
if (tools.exec?.mode !== 'auto') fail('exec mode must use native automatic review before human fallback');
if (tools.exec?.strictInlineEval !== true) fail('strictInlineEval must be enabled');
if (tools.exec?.commandHighlighting !== true) fail('command highlighting must be enabled');
if ('safeBins' in (tools.exec ?? {})) fail('v0 must not introduce safe-bin trust');
if ('reviewer' in (tools.exec ?? {})) fail('v0 must not configure a custom exec reviewer');
if ('elevated' in tools) fail('v0 must not enable elevated execution');
NODE

for required_text in \
  'SUCCESS' \
  'FAILED' \
  'BLOCKED' \
  'The v0 GitHub/implementation capability is read-only.' \
  'Do not automatically retry a failed material mutation.' \
  'A registered scheduled VPS maintenance run is read-only.' \
  'If a weekly exception review finds no material exception, return exactly `NO_REPLY`.'
do
  grep -Fq "$required_text" "$ROOT/workspace/AGENTS.md" || fail "workspace contract marker missing: $required_text"
done

if grep -RIEq --exclude='validate.sh' \
  '(-----BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|botToken[[:space:]]*[=:][[:space:]]*[^<[:space:]]+)' \
  "$ROOT"; then
  fail "possible secret material detected"
fi

printf 'ENGINEER_AGENT_SOURCE_VALID\n'
