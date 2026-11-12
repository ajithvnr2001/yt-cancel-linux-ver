#!/usr/bin/env bash
# One scheduled tick: make sure Brave is reachable, then run one scan/removal.
# This file is safe to run manually:  ./run-check.sh
# Scan-only:                          OCU_SCAN_ONLY=1 ./run-check.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Cron does not inherit the desktop session, so set the X11/DBus environment
# explicitly. These are the values for the logged-in user on this machine.
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

if ! curl -sf --max-time 3 "http://127.0.0.1:${CDP_PORT:-9222}/json/version" >/dev/null 2>&1; then
  "$DIR/launch-brave.sh"
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[yt-automation] node not found on PATH" >&2
  exit 1
fi

exec "$NODE_BIN" "$DIR/cancel-addons-linux.mjs" "$@"
