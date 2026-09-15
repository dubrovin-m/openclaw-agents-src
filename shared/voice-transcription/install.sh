#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
CONFIG="$ROOT/config/tools-media-audio.json"
RUNTIME_CONTRACT="$ROOT/../../runtime-contract.json"
WHISPER_COMMIT="306c88f4d1286aec1bf96e544632897886af5501"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
MODEL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
BIN_TARGET="/home/dubrovin/.local/bin/whisper-cli"
MODEL_TARGET="/home/dubrovin/.local/share/whisper.cpp/models/ggml-small.bin"
OPENCLAW_CONFIG="/home/dubrovin/.openclaw/openclaw.json"
MIN_MEM_KIB=3500000
MIN_ROOT_FREE_KIB=$((3 * 1024 * 1024))

fail() {
  echo "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

[ "$(id -u)" -ne 0 ] || fail "Run as the normal OpenClaw owner, not root"
[ "$HOME" = "/home/dubrovin" ] || fail "Unexpected HOME: $HOME"

for cmd in openclaw ffmpeg git cmake cc c++ curl sha256sum jq install mktemp nproc df awk stat date tr systemctl; do
  require_command "$cmd"
done

[ -f "$RUNTIME_CONTRACT" ] || fail "Runtime contract not found: $RUNTIME_CONTRACT"
OPENCLAW_VERSION=$(jq -er '.openclaw.version | select(type == "string" and length > 0)' "$RUNTIME_CONTRACT") || fail "Invalid OpenClaw version in runtime contract"
[ "$(openclaw --version | awk '{print $2}')" = "$OPENCLAW_VERSION" ] || fail "Expected OpenClaw $OPENCLAW_VERSION"
[ "$(nproc)" -ge 2 ] || fail "At least 2 vCPU are required"
mem_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
[ "${mem_kib:-0}" -ge "$MIN_MEM_KIB" ] || fail "At least 4 GiB-class RAM is required"
root_free_kib=$(df -Pk / | awk 'NR==2 {print $4}')
[ "${root_free_kib:-0}" -ge "$MIN_ROOT_FREE_KIB" ] || fail "At least 3 GiB free root space is required"
[ -f "$OPENCLAW_CONFIG" ] || fail "OpenClaw config not found"
[ "$(stat -c '%a' "$OPENCLAW_CONFIG")" = "600" ] || fail "OpenClaw config must remain owner-only"
[ ! -e "$BIN_TARGET" ] || fail "Refusing to overwrite existing $BIN_TARGET"
[ ! -e "$MODEL_TARGET" ] || fail "Refusing to overwrite existing $MODEL_TARGET"

jq -e '(.tools.media.audio? == null) and (.tools.media.models? == null)' "$OPENCLAW_CONFIG" >/dev/null || fail "tools.media audio configuration already exists; refusing to overwrite"
jq -e . "$CONFIG" >/dev/null

workdir=$(mktemp -d)
backup_file=""
installed_artifacts=0
config_apply_started=0
success=0

cleanup() {
  status=$?
  if [ "$success" -ne 1 ]; then
    if [ "$config_apply_started" -eq 1 ] && [ -n "$backup_file" ] && [ -f "$backup_file" ]; then
      echo "Deployment failed; restoring pre-change OpenClaw config" >&2
      install -m 600 "$backup_file" "$OPENCLAW_CONFIG" || true
      openclaw config validate >/dev/null 2>&1 || true
    fi
    if [ "$installed_artifacts" -eq 1 ]; then
      rm -f "$BIN_TARGET" "$MODEL_TARGET"
    fi
  fi
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

src="$workdir/whisper.cpp"
build="$workdir/build"
model_tmp="$workdir/ggml-small.bin"

git clone --quiet --filter=blob:none "$WHISPER_REPO" "$src"
git -C "$src" checkout --quiet --detach "$WHISPER_COMMIT"
[ "$(git -C "$src" rev-parse HEAD)" = "$WHISPER_COMMIT" ] || fail "whisper.cpp commit verification failed"

cmake -S "$src" -B "$build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build "$build" --target whisper-cli -j "$(nproc)" >/dev/null
[ -x "$build/bin/whisper-cli" ] || fail "whisper-cli build failed"

curl --fail --location --retry 3 --output "$model_tmp" "$MODEL_URL"
printf '%s  %s\n' "$MODEL_SHA256" "$model_tmp" | sha256sum -c - >/dev/null || fail "Whisper model checksum mismatch"

smoke_output=$("$build/bin/whisper-cli" \
  -m "$model_tmp" \
  -np \
  -nt \
  -l en \
  "$src/samples/jfk.wav")
[ -n "$(printf '%s' "$smoke_output" | tr -d '[:space:]')" ] || fail "Offline whisper-cli smoke produced no transcript"

install -d -m 755 "$(dirname "$BIN_TARGET")"
install -d -m 755 "$(dirname "$MODEL_TARGET")"
install -m 755 "$build/bin/whisper-cli" "$BIN_TARGET"
install -m 644 "$model_tmp" "$MODEL_TARGET"
installed_artifacts=1
printf '%s  %s\n' "$MODEL_SHA256" "$MODEL_TARGET" | sha256sum -c - >/dev/null

openclaw config patch --stdin --dry-run < "$CONFIG" >/dev/null

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/home/dubrovin/.openclaw/backups/voice-transcription/$stamp"
install -d -m 700 "$backup_dir"
backup_file="$backup_dir/openclaw.json.before"
install -m 600 "$OPENCLAW_CONFIG" "$backup_file"
sha256sum "$backup_file" > "$backup_dir/openclaw.json.before.sha256"
chmod 600 "$backup_dir/openclaw.json.before.sha256"

config_apply_started=1
openclaw config patch --stdin < "$CONFIG" >/dev/null
openclaw config validate >/dev/null
[ "$(systemctl --user is-active openclaw-gateway.service)" = "active" ] || fail "Gateway is not active after hot apply"

expected=$(jq -c '.tools.media' "$CONFIG")
actual=$(jq -c '.tools.media // null' "$OPENCLAW_CONFIG")
[ "$actual" = "$expected" ] || fail "Applied tools.media differs from source"

success=1
printf 'VOICE_TRANSCRIPTION_STAGE_DEPLOYED\n'
printf 'BACKUP_DIR=%s\n' "$backup_dir"
printf 'GATEWAY_RESTART_REQUIRED=no\n'
