#!/usr/bin/env bash
# Environment health check for yt-cancel-linux-ver.
# Run this first if anything looks wrong:  ./doctor.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDP_PORT="${CDP_PORT:-9222}"
CDP_URL="http://127.0.0.1:${CDP_PORT}"
export DISPLAY="${DISPLAY:-:0}"

ok=0
bad=0
pass() { printf '✅ %s\n' "$*"; ok=$((ok + 1)); }
warn() { printf '⚠️  %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*"; bad=$((bad + 1)); }

echo "yt-cancel-linux-ver doctor"
echo "project: $DIR"
echo "-----------------------------"

# Display
if [ -n "${DISPLAY:-}" ]; then
  pass "DISPLAY is set to $DISPLAY"
else
  fail "DISPLAY is not set (run inside the desktop session)"
fi

# Node
if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  node_major="${node_version%%.*}"
  if [ "${node_major:-0}" -ge 18 ] 2>/dev/null; then
    pass "Node.js v$node_version"
  else
    fail "Node.js v$node_version is too old (need 18+)"
  fi
else
  fail "Node.js not found (see README section 5.1)"
fi

# Engine syntax
if [ -f "$DIR/cancel-addons-linux.mjs" ] && node --check "$DIR/cancel-addons-linux.mjs" >/dev/null 2>&1; then
  pass "engine syntax OK"
else
  fail "cancel-addons-linux.mjs missing or has a syntax error"
fi

# Brave
if command -v brave-browser >/dev/null 2>&1 || command -v brave-browser-stable >/dev/null 2>&1; then
  pass "Brave is installed"
else
  fail "Brave not found (see README section 5.2)"
fi
if pgrep -x brave >/dev/null 2>&1; then
  pass "Brave is running"
else
  warn "Brave is not running (start it with ./launch-brave.sh)"
fi

# CDP
if curl -sf --max-time 3 "$CDP_URL/json/version" >/dev/null 2>&1; then
  pass "CDP is listening on $CDP_URL"
  cdp_ok=1
else
  fail "CDP is not listening on $CDP_URL (run ./launch-brave.sh)"
  cdp_ok=0
fi

# YouTube TV tab
if [ "${cdp_ok:-0}" -eq 1 ]; then
  if curl -s --max-time 3 "$CDP_URL/json/list" | grep -q 'tv\.youtube\.com'; then
    pass "a YouTube TV tab is open"
  else
    warn "no tv.youtube.com tab is open (launch-brave.sh opens one)"
  fi
fi

# Cron daemon + schedule
if pgrep -x cron >/dev/null 2>&1; then
  pass "cron daemon is running"
else
  fail "cron daemon is not running"
fi
if crontab -l 2>/dev/null | grep -qF '# yt-automation'; then
  pass "15-minute schedule is installed"
else
  warn "schedule is not installed (run ./install-cron.sh 15)"
fi

# Persistent Brave launcher override
if grep -q -- '--remote-debugging-port=9222' \
  "$HOME/.local/share/applications/brave-browser.desktop" 2>/dev/null; then
  pass "Brave menu launcher includes the CDP flag"
else
  warn "Brave menu launcher override not found (README section 5.6)"
fi

echo "-----------------------------"
if [ "$bad" -eq 0 ]; then
  echo "All critical checks passed ($ok passed)."
  echo "Next: OCU_SCAN_ONLY=1 ./run-check.sh"
  exit 0
else
  echo "$bad critical check(s) failed. Fix the ❌ items above."
  exit 1
fi
