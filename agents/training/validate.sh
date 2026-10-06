#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
python3 - "$ROOT" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
for rel in ["config/training-agent.fragment.json","config/training-tools.json","plugin/package.json","plugin/openclaw.plugin.json","release.json"]:
    with (root/rel).open(encoding="utf-8") as f:
        json.load(f)
required=[
  "README.md","ACCEPTANCE.md","workspace/AGENTS.md","workspace/IDENTITY.md","workspace/SOUL.md","workspace/USER.md","workspace/HEARTBEAT.md",
  "plugin/src/store.ts","plugin/src/domain.ts","plugin/src/plugin.ts",
  "deploy.sh","deploy-support.mjs","tests/deploy.sh","tests/release.sh",
  "artifacts/openclaw-plugin-training-0.1.0.tgz","artifacts/openclaw-plugin-training-0.1.0.sha256"
]
missing=[p for p in required if not (root/p).is_file()]
if missing:
    raise SystemExit("missing Training files: "+", ".join(missing))
text=(root/"config/training-tools.json").read_text()
for forbidden in ['"exec"','"write"','"gateway"','"sessions_spawn"']:
    if forbidden not in text:
        raise SystemExit("missing forbidden tool policy: "+forbidden)
print("TRAINING_SOURCE_BOUNDARY_PASS")
PY
python3 - "$ROOT" <<'PY'
import json, pathlib, re, sys
root=pathlib.Path(sys.argv[1])
plugin=(root/'plugin/src/plugin.ts').read_text()
actual=re.findall(r'name:\s*"(training_[^"]+)"',plugin)
manifest=json.load((root/'plugin/openclaw.plugin.json').open())['contracts']['tools']
allow=json.load((root/'config/training-tools.json').open())['allow']
if len(actual)!=len(set(actual)):
    raise SystemExit('duplicate Training tool name in plugin source')
if set(actual)!=set(manifest) or len(actual)!=len(manifest):
    raise SystemExit(f'Training manifest mismatch: actual={actual} manifest={manifest}')
if set(actual)!=set(allow) or len(actual)!=len(allow):
    raise SystemExit(f'Training allow-list mismatch: actual={actual} allow={allow}')
print('TRAINING_TOOL_CONTRACT_PASS')
PY
python3 - "$ROOT" <<'PY'
import pathlib, sys
root=pathlib.Path(sys.argv[1])
text=(root/'deploy.sh').read_text()
for forbidden in ['agents add','agents bind','plugins enable','systemctl','openclaw-gateway','telegram:training']:
    if forbidden in text:
        raise SystemExit('stage-only Training deploy contains forbidden activation operation: '+forbidden)
for required in ['plugins install --force --accept-capabilities','plugins.entries.training.enabled false','TRAINING_DEPLOY_STAGE_PASS']:
    if required not in text:
        raise SystemExit('stage-only Training deploy missing required control: '+required)
print('TRAINING_DEPLOY_STAGE_BOUNDARY_PASS')
PY
