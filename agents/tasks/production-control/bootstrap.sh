#!/usr/bin/env bash
set -euo pipefail
umask 077

PRODUCTION_SHA=""
CONTROLLER_SHA=""
CONTROL_REPOSITORY=""
IMPLEMENTATION_REPOSITORY=""
CONTROL_ISSUE=""
OWNER_LOGIN=""
OWNER_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --production-sha) [ "$#" -ge 2 ] || { echo "--production-sha requires SHA" >&2; exit 2; }; PRODUCTION_SHA=$2; shift 2 ;;
    --controller-sha) [ "$#" -ge 2 ] || { echo "--controller-sha requires SHA" >&2; exit 2; }; CONTROLLER_SHA=$2; shift 2 ;;
    --control-repository) [ "$#" -ge 2 ] || { echo "--control-repository requires OWNER/REPO" >&2; exit 2; }; CONTROL_REPOSITORY=$2; shift 2 ;;
    --implementation-repository) [ "$#" -ge 2 ] || { echo "--implementation-repository requires OWNER/REPO" >&2; exit 2; }; IMPLEMENTATION_REPOSITORY=$2; shift 2 ;;
    --control-issue) [ "$#" -ge 2 ] || { echo "--control-issue requires number" >&2; exit 2; }; CONTROL_ISSUE=$2; shift 2 ;;
    --owner-login) [ "$#" -ge 2 ] || { echo "--owner-login requires login" >&2; exit 2; }; OWNER_LOGIN=$2; shift 2 ;;
    --owner-id) [ "$#" -ge 2 ] || { echo "--owner-id requires numeric id" >&2; exit 2; }; OWNER_ID=$2; shift 2 ;;
    *) echo "Unknown bootstrap argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$PRODUCTION_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid production SHA" >&2; exit 2; }
[[ "$CONTROLLER_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid controller SHA" >&2; exit 2; }
[[ "$CONTROL_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid control repository" >&2; exit 2; }
[[ "$IMPLEMENTATION_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid implementation repository" >&2; exit 2; }
[ "$CONTROL_REPOSITORY" != "$IMPLEMENTATION_REPOSITORY" ] || { echo "Control and implementation repositories must be distinct" >&2; exit 2; }
[[ "$CONTROL_ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid control issue" >&2; exit 2; }
[[ "$OWNER_LOGIN" =~ ^[A-Za-z0-9-]+$ ]] || { echo "Invalid owner login" >&2; exit 2; }
[[ "$OWNER_ID" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid owner id" >&2; exit 2; }

LIB_DIR="${OPC_LIB_DIR:-$HOME/.local/lib/openclaw-production-control}"
CONTROLLER="${OPC_CONTROLLER:-$LIB_DIR/controller.mjs}"
REVISION_FILE="${OPC_INSTALLED_REVISION_FILE:-$LIB_DIR/installed-revision}"

[ -f "$REVISION_FILE" ] || { echo "Installed controller revision evidence missing" >&2; exit 2; }
INSTALLED_REVISION=$(tr -d '\r\n' < "$REVISION_FILE")
[[ "$INSTALLED_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Installed controller revision evidence invalid" >&2; exit 2; }
[ "$INSTALLED_REVISION" = "$CONTROLLER_SHA" ] || { echo "Installed controller revision does not match approved controller SHA" >&2; exit 2; }
[ -x "$CONTROLLER" ] || { echo "Installed controller entrypoint missing" >&2; exit 2; }

exec "$CONTROLLER" bootstrap \
  --production-sha "$PRODUCTION_SHA" \
  --controller-sha "$CONTROLLER_SHA" \
  --control-repository "$CONTROL_REPOSITORY" \
  --implementation-repository "$IMPLEMENTATION_REPOSITORY" \
  --control-issue "$CONTROL_ISSUE" \
  --owner-login "$OWNER_LOGIN" \
  --owner-id "$OWNER_ID"
