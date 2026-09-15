#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
TEST_ROOT=""
if [[ "$#" -eq 1 && "$1" == --apply ]]; then
  :
elif [[ "$#" -eq 3 && "$1" == --test-root && "$3" == --apply ]]; then
  TEST_ROOT=$2
else
  echo "Usage: $0 --apply | --test-root /absolute/path --apply" >&2
  exit 2
fi

for cmd in age curl install node systemctl; do command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }; done

if [[ -n "$TEST_ROOT" ]]; then
  [[ "$TEST_ROOT" == /* && "$TEST_ROOT" != / ]] || { echo "Unsafe test root" >&2; exit 2; }
  mkdir -p "$TEST_ROOT"
  HOME_DIR="$TEST_ROOT/home"
  LIB_DIR="$HOME_DIR/.local/lib/nexus-recovery"
  UNIT_DIR="$HOME_DIR/.config/systemd/user"
  CONFIG="$HOME_DIR/.config/nexus-recovery/task-backup.env"
else
  HOME_DIR="$HOME"
  LIB_DIR="$HOME_DIR/.local/lib/nexus-recovery"
  UNIT_DIR="$HOME_DIR/.config/systemd/user"
  CONFIG="$HOME_DIR/.config/nexus-recovery/task-backup.env"
fi

install -d -m 700 "$LIB_DIR" "$UNIT_DIR"
install -m 700 "$ROOT/backup.sh" "$LIB_DIR/task-independent-backup.sh"
install -m 600 "$ROOT/task-independent-backup.service" "$UNIT_DIR/task-independent-backup.service"
install -m 600 "$ROOT/task-independent-backup.timer" "$UNIT_DIR/task-independent-backup.timer"

if [[ -n "$TEST_ROOT" ]]; then
  test -x "$LIB_DIR/task-independent-backup.sh"
  test -f "$UNIT_DIR/task-independent-backup.service"
  test -f "$UNIT_DIR/task-independent-backup.timer"
  echo "TASK_INDEPENDENT_BACKUP_INSTALL_TEST_PASS"
  exit 0
fi

[[ -f "$CONFIG" ]] || { echo "External config missing: $CONFIG" >&2; exit 2; }
systemctl --user daemon-reload
systemctl --user enable --now task-independent-backup.timer
echo "TASK_INDEPENDENT_BACKUP_INSTALL_PASS"
