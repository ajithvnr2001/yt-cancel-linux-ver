#!/usr/bin/env bash
# Safe self-test of the server-rejection branch.
#
# It opens a local mock "subscriptions" page in Brave, runs the engine against
# it twice, and checks that:
#   1. Remove -> Yes, cancel is executed,
#   2. the "error canceling your membership" text is detected,
#   3. the run logs "will retry on the next 15-minute tick",
#   4. the next run retries the same item.
#
# It never visits the real YouTube TV page and never changes a subscription.
# Cleanup closes the mock tab, stops the server, and deletes temp logs.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDP_PORT="${CDP_PORT:-9222}"
CDP="http://127.0.0.1:${CDP_PORT}"
PORT="${MOCK_PORT:-8765}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/yt-automation-test.XXXXXX")"
TAB=""
SERVER_PID=""

cleanup() {
  if [ -n "$TAB" ]; then
    curl -s --max-time 2 "$CDP/json/close/$TAB" >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -f "$TMP/cancel-log.txt" ]; then
    echo "--- engine log ---" >&2
    cat "$TMP/cancel-log.txt" >&2
  fi
  exit 1
}

# --- prerequisites ---------------------------------------------------------
if ! curl -sf --max-time 3 "$CDP/json/version" >/dev/null 2>&1; then
  fail "Brave CDP is not available at $CDP. Start it with ./launch-brave.sh"
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 is required for the mock server"
fi

# --- start the mock page ---------------------------------------------------
python3 -m http.server "$PORT" --directory "$DIR/test/mock" >/dev/null 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 20); do
  curl -sf --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  fail "could not start the mock server on port $PORT (try MOCK_PORT=8877)"
fi

# --- open a tab for it -----------------------------------------------------
TAB="$(curl -s --max-time 5 -X PUT "$CDP/json/new?http://127.0.0.1:$PORT/" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id", ""))' 2>/dev/null)"
if [ -z "$TAB" ]; then
  fail "could not open the mock tab through CDP"
fi
sleep 1

# --- run the engine twice --------------------------------------------------
for _ in 1 2; do
  TV_URL="http://127.0.0.1:$PORT/" \
  OCU_URL_PATTERN="127\\.0\\.0\\.1:${PORT}" \
  OCU_AUTOMATION_DIR="$TMP" \
  "$DIR/run-check.sh" >/dev/null 2>&1 || true
done

LOG="$TMP/cancel-log.txt"
[ -f "$LOG" ] || fail "the engine did not write a log"

retry_lines="$(grep -c 'will retry on the next 15-minute tick' "$LOG" || true)"
[ "${retry_lines:-0}" -ge 2 ] || fail "expected the rejection to be retried on the second run"

grep -q 'clicking Remove for: Test Add-on' "$LOG" || fail "Remove was not clicked"
grep -q 'confirming with "Yes, cancel"' "$LOG" || fail "Yes, cancel was not clicked"
grep -q 'error canceling your membership' "$LOG" || fail "the rejection text was not logged"

echo "PASS: error branch handled and retried"
echo "  Remove clicked .......... yes"
echo "  Yes, cancel clicked ..... yes"
echo "  rejection detected ...... yes"
echo "  retried on next run ..... yes"
exit 0
