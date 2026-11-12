#!/usr/bin/env bash
# Start Brave in the mode the automation needs (CDP on 127.0.0.1:9222).
# If Brave is already running without that port, do NOT kill it — just fail
# with a clear message, so a scheduled tick can never destroy a browsing session.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_URL="${TV_URL:-https://tv.youtube.com/settings/subscriptions}"
CDP_PORT="${CDP_PORT:-9222}"
CDP_URL="http://127.0.0.1:${CDP_PORT}/json/version"

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

if curl -sf --max-time 3 "$CDP_URL" >/dev/null 2>&1; then
  exit 0
fi

if pgrep -x brave >/dev/null 2>&1; then
  echo "[yt-automation] Brave is running without --remote-debugging-port=${CDP_PORT}." >&2
  echo "[yt-automation] Close Brave completely and run this script again, or use the patched launcher." >&2
  exit 1
fi

echo "[yt-automation] starting Brave with CDP on 127.0.0.1:${CDP_PORT}"
setsid /usr/bin/brave-browser \
  --remote-debugging-port="${CDP_PORT}" \
  --force-renderer-accessibility \
  --restore-last-session \
  "$TV_URL" >/tmp/yt-automation-brave.log 2>&1 < /dev/null &

for _ in $(seq 1 30); do
  sleep 1
  if curl -sf --max-time 2 "$CDP_URL" >/dev/null 2>&1; then
    exit 0
  fi
done

echo "[yt-automation] Brave did not open the CDP port in time; see /tmp/yt-automation-brave.log" >&2
exit 1
