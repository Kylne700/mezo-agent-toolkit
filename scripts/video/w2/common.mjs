// Wave 2 demo video: shared paths and the headless browser. The Wave 1 pipeline in ../ is not changed; this folder only reads its config and helpers.
// No local AI models anywhere: the voice and its check are the cloud tools in tools/cloud-voice, the rest is node, ffmpeg and headless Chromium.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHROMIUM, FONTS, PW_BROWSERS, PW_CORE, REPO_URL, ROOT, TOOLS } from '../config.mjs'

export { FONTS, REPO_URL, ROOT, TOOLS }
export { run } from '../lib.mjs'
export const OUT = resolve(ROOT, 'media/w2') // media/ is gitignored: nothing in here is committed
export const RAW = join(OUT, 'raw')
export const CV = join(TOOLS, 'cloud-voice') // say.mjs, hear.mjs (Cloudflare Workers AI, contest account)
export const PORT = Number(process.env.W2_VOICE_PORT ?? 18850) // the cloud-voice Worker for this build: ports 18850-18899 only
export const W = 1280
export const STAGE_H = 624 // the picture; the 96 px under it carries the captions (as in Wave 1)
export const H = 720
for (const d of [OUT, RAW]) mkdirSync(d, { recursive: true })

/** Headless Chromium, no display. */
export async function browser() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= PW_BROWSERS // before the import: playwright reads it once, and recordVideo needs its ffmpeg from there
  const { chromium } = await import(pathToFileURL(join(PW_CORE, 'index.mjs')).href)
  return chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })
}
