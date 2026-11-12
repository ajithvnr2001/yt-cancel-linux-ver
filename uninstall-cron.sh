#!/usr/bin/env bash
# Remove the yt-automation crontab entry (stops automatic runs).
set -euo pipefail

MARKER="# yt-automation"

if ! crontab -l 2>/dev/null | grep -qF "$MARKER"; then
  echo "No yt-automation crontab entry found — nothing to remove."
  exit 0
fi

{ crontab -l 2>/dev/null | grep -vF "$MARKER" || true; } | crontab -
echo "Removed the yt-automation crontab entry. Automatic runs are stopped."
