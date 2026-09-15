#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
CONFIG="$ROOT/config/tools-media-audio.json"
INSTALLER="$ROOT/install.sh"
RUNTIME_CONTRACT="$ROOT/../../runtime-contract.json"
MODEL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
BIN_TARGET="/home/dubrovin/.local/bin/whisper-cli"
MODEL_TARGET="/home/dubrovin/.local/share/whisper.cpp/models/ggml-small.bin"

fail() {
  echo "$*" >&2
  exit 2
}

command -v jq >/dev/null || fail "jq is required"
test -f "$RUNTIME_CONTRACT" || fail "Runtime contract not found: $RUNTIME_CONTRACT"
OPENCLAW_VERSION=$(jq -er '.openclaw.version | select(type == "string" and length > 0)' "$RUNTIME_CONTRACT") || fail "Invalid OpenClaw version in runtime contract"
jq -e . "$CONFIG" >/dev/null
bash -n "$INSTALLER"

jq -e '
  .tools.media.audio.enabled == true and
  .tools.media.audio.scope.default == "deny" and
  (.tools.media.audio.scope.rules | length) == 1 and
  .tools.media.audio.scope.rules[0].action == "allow" and
  .tools.media.audio.scope.rules[0].match.channel == "telegram" and
  .tools.media.audio.scope.rules[0].match.chatType == "direct" and
  (.tools.media.audio.models? == null) and
  (.tools.media.models | length) == 1 and
  .tools.media.models[0].capabilities == ["audio"] and
  .tools.media.models[0].type == "cli" and
  .tools.media.models[0].command == "/home/dubrovin/.local/bin/whisper-cli" and
  (.tools.media.models[0].args | index("/home/dubrovin/.local/share/whisper.cpp/models/ggml-small.bin")) != null and
  (.tools.media.models[0].args | index("{{OutputBase}}")) != null and
  (.tools.media.models[0].args | index("{{MediaPath}}")) != null and
  (.tools.media.models[0].args | index("auto")) != null and
  .tools.media.models[0].timeoutSeconds == 180 and
  .tools.media.audio.echoTranscript == false
' "$CONFIG" >/dev/null || fail "Unexpected target tools.media contract"

grep -Fq '306c88f4d1286aec1bf96e544632897886af5501' "$INSTALLER" || fail "whisper.cpp commit pin missing"
grep -Fq "$MODEL_SHA256" "$INSTALLER" || fail "model SHA256 pin missing from installer"

case "${1:-}" in
  "")
    test "$#" -eq 0 || fail "Usage: $0 [--runtime]"
    ;;
  --runtime)
    test "$#" -eq 1 || fail "Usage: $0 [--runtime]"
    test -x "$BIN_TARGET" || fail "whisper-cli is not installed"
    test -f "$MODEL_TARGET" || fail "Whisper model is not installed"
    printf '%s  %s\n' "$MODEL_SHA256" "$MODEL_TARGET" | sha256sum -c - >/dev/null
    command -v ffmpeg >/dev/null || fail "ffmpeg is not installed"
    test "$(openclaw --version | awk '{print $2}')" = "$OPENCLAW_VERSION" || fail "Unexpected OpenClaw version"

    expected=$(jq -S -c '.tools.media' "$CONFIG")
    actual=$(jq -S -c '.tools.media // null' /home/dubrovin/.openclaw/openclaw.json)
    test "$actual" = "$expected" || fail "Runtime tools.media differs from source"

    openclaw config validate >/dev/null
    test "$(systemctl --user is-active openclaw-gateway.service)" = "active" || fail "Gateway is not active"
    ;;
  *)
    fail "Usage: $0 [--runtime]"
    ;;
esac

printf 'VOICE_TRANSCRIPTION_VALIDATION_PASS\n'
