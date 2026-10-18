// Reads scripts/video/narration.md: `## n. title` opens a story step, `### id` a beat (one clip of the video), other lines are sentences.
// Adapted from the author's own MIT-licensed Sealdrop video chain. `{{name}}` in a sentence is filled from the current take (media/raw/take.json,
// key `narrationVars`), so a number on screen and in the voice-over always come from the same run.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RAW, TTS_RESPELL } from './config.mjs'

const MD = resolve(dirname(fileURLToPath(import.meta.url)), 'narration.md')
const TAKE = resolve(RAW, 'take.json')
// shortcut: without a take the rehearsal numbers below are used (a trial run of the voice); build.sh always takes first, so the video never uses them.
const vars = () => (existsSync(TAKE) ? JSON.parse(readFileSync(TAKE, 'utf8')).narrationVars ?? {} : { steps: 31 })

export function parseNarration(md = readFileSync(MD, 'utf8'), v = vars()) {
  const steps = []
  let step = null, beat = null
  for (const raw of md.split('\n')) {
    const line = raw.trim().replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in v)) throw new Error(`narration.md uses {{${k}}} but media/raw/take.json has no narrationVars.${k}; run the take first`)
      return String(v[k])
    })
    let m
    if ((m = line.match(/^## (\d+)\. (.+)$/))) { step = { n: Number(m[1]), title: m[2], beats: [] }; steps.push(step); beat = null; continue }
    if ((m = line.match(/^### ([\w-]+)$/))) { beat = { id: m[1], step: step.n, sentences: [] }; step.beats.push(beat); continue }
    if (!line || line.startsWith('#') || !step || !beat) continue
    beat.sentences.push(line)
  }
  return steps
}

export const wordCount = (steps) => steps.flatMap((s) => s.beats).flatMap((b) => b.sentences).join(' ').split(/\s+/).filter(Boolean).length

/** What the speech engine reads: the sentence with the respell pairs applied. Captions keep the printed form. */
export const spoken = (text) => TTS_RESPELL.reduce((t, [from, to]) => t.split(from).join(to), text)

/** Splits a sentence into caption chunks of at most `max` characters (one line of the caption box), preferring commas, colons and full stops. */
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'is', 'are', 'that'])
export function captionChunks(sentence, max = 52) {
  // a chunk that is still too long is cut at the space nearest its middle, recursively; a cut after a small word (the, of, on ...) or before a
  // number ("October | 18") is avoided unless it would leave the pieces more than 12 characters apart
  const fit = (c) => {
    if (c.length <= max) return [c]
    let cut = -1, cost = Infinity
    for (let i = c.indexOf(' ', 1); i > 0; i = c.indexOf(' ', i + 1)) {
      const bad = STOP.has(c.slice(0, i).split(' ').at(-1).toLowerCase()) || /^\d/.test(c.slice(i + 1))
      const k = Math.abs(i - c.length / 2) + (bad ? 12 : 0) + (c.length <= 2 * max + 1 && Math.max(i, c.length - i - 1) > max ? 40 : 0) // two lines are better than three
      if (k < cost) { cost = k; cut = i }
    }
    return cut > 0 ? [...fit(c.slice(0, cut)), ...fit(c.slice(cut + 1))] : [c]
  }
  const out = []
  for (const p of sentence.split(/(?<=[,:;.])\s+/)) {
    if (out.length && (out.at(-1) + ' ' + p).length <= max) out[out.length - 1] += ' ' + p
    else out.push(p)
  }
  return out.flatMap(fit)
}
