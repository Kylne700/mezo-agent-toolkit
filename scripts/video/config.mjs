// Shared settings for the demo-video pipeline. Adapted from the author's own MIT-licensed Sealdrop video chain (github.com/Kylne700/sealdrop).
// Paths are derived from this file's location, never hard-coded: the repo sits next to a `tools/` folder (TTS voices) that is not part of it.
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')
export const TOOLS = process.env.VIDEO_TOOLS ?? resolve(ROOT, '../tools')
export const MEDIA = resolve(ROOT, 'media') // gitignored: the mp4 and everything it is made of
export const RAW = resolve(MEDIA, 'raw')
export const FONTS = resolve(ROOT, 'docs/fonts') // Inter and JetBrains Mono (OFL), also used by the deck
export const DENYLIST = resolve(TOOLS, 'privacy-denylist.txt')

// ---- THE NARRATOR: one variable. Numbers are the voice numbers in tools/tts-samples/KEY.md. Default 3 = Kokoro af_heart.
// The command is the one on KEY.md line 43 as written: say.py's own defaults (speed 1.0, en-us) apply, no flag for either.
export const VOICE = Number(process.env.VOICE ?? 3)
const kokoro = (voice) => ({ engine: 'kokoro', py: 'tts-kokoro/.venv/bin/python', model: 'tts-voices/kokoro-v1.0/kokoro-v1.0.onnx', voices: 'tts-voices/kokoro-v1.0/voices-v1.0.bin', voice })
const piper = (dir, name) => ({ engine: 'piper', py: 'tts/.venv/bin/python', model: `tts-voices/${dir}/${name}.onnx` })
export const VOICES = {
  1: { label: 'piper en_US-ljspeech-high', ...piper('piper-en_US-ljspeech-high', 'en_US-ljspeech-high') },
  2: { label: 'piper en_GB-cori-high', ...piper('piper-en_GB-cori-high', 'en_GB-cori-high') },
  3: { label: 'Kokoro af_heart', ...kokoro('af_heart') },
}
export const SAY = resolve(TOOLS, 'tts-kokoro/say.py')

// Spelled differently for the speech engine than on screen (captions keep the printed form). Longest first. Add a pair only when the
// printed form sounds wrong or the ASR check (asr-compare.mjs) hears something else.
export const TTS_RESPELL = [
  ['Mezo', 'Mez-oh'], // plain Mezo is spoken Mee-zo (misheard as Meso); Mez-oh is heard as Mezo in every test sentence
  ['Testnet', 'Test net'], // plain Testnet was heard as "test it" at the end of the video
  ['vote-escrow', 'vote escrow'],
  ['x402', 'x four oh two'],
  ['402', 'four oh two'],
  ['0.001', 'zero point zero zero one'],
  ['Permit2', 'Permit two'],
  ['MUSD', 'M USD'],
  ['MCP', 'M C P'],
  ['URL', 'U R L'],
  ['README', 'read me'],
  ['October 18', 'October eighteenth'],
]

// Timeline constants (seconds).
export const GAP = 0.3 // silence between sentences inside one beat
export const TAIL = 0.4 // silence after the last sentence of a beat
export const END_TAIL = 1.2 // the end card stays this long after the last word (under the 1.5 s dead-air limit)
export const MAX_SECONDS = 120 // the page asks for a 2-minute pitch video
export const BUILD_MAX_SECONDS = 118 // the build fails above this, so the limit holds with a margin
export const SETTLEMENT_BY = 30 // the explorer beat (the settlement, checkable) must start before this second
export const FPS = 25 // Playwright's recordVideo rate
export const W = 1280
export const H = 720

// Playwright (browser scenes and screenshots): env PLAYWRIGHT_CORE / PLAYWRIGHT_BROWSERS_PATH, else the install under the home folder.
const PW_HOME = join(homedir(), '.local/share/claude-playwright-mcp')
export const PW_CORE = process.env.PLAYWRIGHT_CORE ?? join(PW_HOME, 'node_modules/playwright-core')
export const PW_BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(PW_HOME, 'browsers')
export const CHROMIUM = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'

export const REPO_URL ='https://github.com/Kylne700/mezo-agent-toolkit'
export const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
