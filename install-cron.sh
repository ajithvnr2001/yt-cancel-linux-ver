#!/usr/bin/env bash
# Install (or replace) the 15-minute user crontab entry.
# Usage: ./install-cron.sh [interval-minutes]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${1:-15}"
MARKER="# yt-automation"

chmod +x "$DIR/run-check.sh" "$DIR/launch-brave.sh" "$DIR/cancel-addons-linux.mjs"

LINE="*/${INTERVAL} * * * * $DIR/run-check.sh >> $DIR/cron.log 2>&1 $MARKER"

{
  crontab -l 2>/dev/null | grep -vF "$MARKER" || true
  echo "$LINE"
} | crontab -

echo "Installed ${INTERVAL}-minute schedule:"
echo "  $LINE"
echo
echo "Verify with: crontab -l"
echo "Watch it with: tail -f $DIR/cron.log $DIR/cancel-log.txt"
