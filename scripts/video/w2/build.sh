#!/usr/bin/env bash
# Wave 2 demo video -> media/w2/w2-demo.mp4 (gitignored). Free reads and live explorer pages only: no key, no signing, no spend.
# Needs the cloud-voice Worker (tools/cloud-voice, Cloudflare CONTEST account) running on 127.0.0.1:${W2_VOICE_PORT:-18850}.
# Voice: Cloudflare Workers AI aura-1 / angus (cap 3000 neurons per UTC day, cached per sentence); its check is the cloud speech-to-text. No local model.
# Does not call ../build.sh (the Wave 1 take): that one pays.
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unset DISPLAY
node "$D/facts.mjs"                       # evidence files + MCP sessions (keyless) + vitest on the 3 fix tests
node "$D/screens.mjs" slides
mullvad-exclude node "$D/screens.mjs" live # the two explorer pages of Proof 1, headless
node "$D/voice.mjs" say                   # new or changed sentences cost neurons; unchanged ones are cached
node "$D/voice.mjs" build
node "$D/voice.mjs" hear                  # exit 1 when a beat is over WER 0.05
node "$D/assemble.mjs"
node "$D/assemble.mjs" frames             # one frame per scene in media/w2/raw/frames: look at them
