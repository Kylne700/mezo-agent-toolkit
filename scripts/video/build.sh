#!/usr/bin/env bash
# Builds media/demo.mp4 and docs/deck.pdf from scratch: take -> narration -> scenes -> assemble -> post checks -> deck facts -> deck.
#   CONFIRM_PAY=1 MEZO_KEY_FILE=<key file> [BASE_URL=<worker url>] bash scripts/video/build.sh
#       the full take: ONE real run on Mezo testnet, two payments of 0.001 MUSD (never retried); without BASE_URL the Worker runs locally under wrangler dev
#   SKIP_TAKE=1 bash scripts/video/build.sh
#       rebuilds everything from the take already in media/raw/take.json: nothing is spent
#   BASE_URL=<deployed worker url> bash scripts/video/build.sh --live-only
#       refilms only the explorer page and the console page against BASE_URL (free routes), then rebuilds: nothing is spent
# BASE_URL decides these scenes: paid (the unpaid 402 and the signed call), explorer (the page of the first payment, filmed live), mcp-cap (the MCP calls),
# console (the Worker's console page, filmed live). mcp-tools and lens are redrawn from the same take; problem, nodouble and end do not depend on it.
# The key file is passed only as MEZO_KEY_FILE and read in code, never printed. Needs the tools of scripts/video/config.mjs (Kokoro, ffmpeg, Chromium).
set -euo pipefail
unset DISPLAY # never drive or capture a real display
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
V=scripts/video

if [ "${1:-}" = "--live-only" ]; then
  [ -n "${BASE_URL:-}" ] || { echo "--live-only needs BASE_URL (the deployed Worker)" >&2; exit 2; }
  node --import tsx $V/take.ts --live-only --url "$BASE_URL"
elif [ -z "${SKIP_TAKE:-}" ]; then
  [ -n "${MEZO_KEY_FILE:-}" ] || { echo "the full take needs MEZO_KEY_FILE" >&2; exit 2; }
  [ "${CONFIRM_PAY:-}" = "1" ] || { echo "the full take spends 2 x 0.001 MUSD on Mezo testnet: set CONFIRM_PAY=1 to go on, or SKIP_TAKE=1 to reuse media/raw/take.json" >&2; exit 2; }
  node --import tsx $V/take.ts ${BASE_URL:+--url "$BASE_URL"}
fi

node $V/tts.mjs
node $V/scenes.mjs
node $V/assemble.mjs
node $V/post.mjs
node $V/facts.mjs
TZ=UTC node scripts/deck/build.mjs
