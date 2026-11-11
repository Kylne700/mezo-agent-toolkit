// Narration -> audio, all in the cloud (tools/cloud-voice: Cloudflare Workers AI aura-1 / angus, CONTEST account). No local model.
//   node voice.mjs say [--dry]  one WAV per sentence (the cache means an unchanged sentence costs nothing); --dry prints the neuron estimate only
//   node voice.mjs build        beat WAVs (what hear.mjs checks), master.wav and timing.json
//   node voice.mjs hear         cloud speech-to-text on every beat, threshold 0.05 as the cloud-voice README
// Network calls go through mullvad-exclude (the Worker, wrangler dev on 127.0.0.1:PORT, is started by build.sh).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CV, PORT, RAW, run } from './common.mjs'
import { BEAT_GAP, END_TAIL, GAP, LEAD, script } from './narration.mjs'

const VOICE = join(RAW, 'voice')
const BEATS = join(RAW, 'beats')
const facts = () => JSON.parse(readFileSync(join(RAW, 'facts.json'), 'utf8'))
const cloud = (tool, args) => run('mullvad-exclude', ['node', join(CV, tool), ...args, '--max-neurons', '3000', '--port', String(PORT)])
const ff = (args) => run('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args])
const dur = async (f) => Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout.trim())

/** Places mono WAVs at offsets (seconds) on one 48 kHz track of the given length. */
async function place(items, out, total) {
  const inputs = items.flatMap((i) => ['-i', i.file])
  const chains = items.map((_, k) => `[${k}:a]aresample=48000,adelay=${Math.round(items[k].at * 1000)}:all=1[a${k}]`).join(';')
  const mix = items.map((_, k) => `[a${k}]`).join('') + `amix=inputs=${items.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[o]`
  await ff([...inputs, '-filter_complex', `${chains};${mix}`, '-map', '[o]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out])
}

export async function say(dry) {
  mkdirSync(VOICE, { recursive: true })
  const { beats } = script(facts())
  const lines = beats.flatMap((b) => b.sentences.map((s) => ({ id: s.id, text: s.text })))
  const file = join(RAW, 'sentences.json')
  writeFileSync(file, JSON.stringify(lines, null, 1))
  const r = await cloud('say.mjs', [file, '--model', 'aura-1', '--voice', 'angus', '--out', VOICE, ...(dry ? ['--dry-run'] : [])])
  console.log(r.stdout.split('\n').filter((l) => /neurons|wrote|cache|cloud/.test(l)).slice(0, 4).join('\n'))
}

export async function build() {
  mkdirSync(BEATS, { recursive: true })
  const { beats, segments } = script(facts())
  const d = JSON.parse(readFileSync(join(VOICE, 'durations.json'), 'utf8'))
  const sentences = []
  const timing = { beats: [], sentences, segments: [] }
  let t = LEAD
  for (const b of beats) {
    const start = t
    let at = 0
    const items = []
    for (const s of b.sentences) {
      if (!d[s.id]) throw new Error(`no audio for ${s.id}: run voice.mjs say`)
      items.push({ file: join(VOICE, `${s.id}.wav`), at })
      sentences.push({ id: s.id, beat: b.id, start: start + at, end: start + at + d[s.id], text: s.text })
      at += d[s.id] + GAP + s.pad
    }
    const speech = at - GAP - b.sentences.at(-1).pad // the beat wav ends with its last word
    await place(items, join(BEATS, `${b.id}.wav`), speech)
    timing.beats.push({ id: b.id, start, end: start + speech, text: b.sentences.map((s) => s.text).join(' ') })
    t = start + speech + b.sentences.at(-1).pad + BEAT_GAP
  }
  timing.total = Math.max(...sentences.map((s) => s.end)) + END_TAIL + beats.at(-1).sentences.at(-1).pad
  await place(timing.beats.map((b) => ({ file: join(BEATS, `${b.id}.wav`), at: b.start })), join(RAW, 'master.wav'), timing.total)
  // a screen comes up a little before the first word of its sentence; the first one at 0
  const SW = 0.25
  timing.segments = segments.map((g, i) => ({ ...g, start: i === 0 ? 0 : Math.max(0, sentences.find((s) => s.id === g.from).start - SW) }))
  timing.segments.forEach((g, i) => { g.end = i + 1 < segments.length ? timing.segments[i + 1].start : timing.total })
  writeFileSync(join(RAW, 'timing.json'), JSON.stringify(timing, null, 2) + '\n')
  console.log(`timing: ${timing.total.toFixed(1)} s, ${sentences.length} sentences, ${timing.beats.length} beats, ${timing.segments.length} segments (master ${(await dur(join(RAW, 'master.wav'))).toFixed(1)} s)`)
}

export async function hear() {
  const t = JSON.parse(readFileSync(join(RAW, 'timing.json'), 'utf8'))
  const file = join(RAW, 'beats.json')
  writeFileSync(file, JSON.stringify(t.beats.map((b) => ({ id: b.id, text: b.text })), null, 1))
  let r
  try { r = await cloud('hear.mjs', [file, '--dir', BEATS]) } catch (e) { r = { stdout: String(e.message) } } // exit 1 = a beat over the threshold: show the table
  console.log(r.stdout.split('\n').filter((l) => l.trim()).join('\n'))
  const rows = JSON.parse(readFileSync(join(BEATS, 'hear.json'), 'utf8'))
  const bad = rows.filter((x) => x.flagged)
  console.log(bad.length ? `HEAR FAIL: ${bad.map((x) => x.id).join(', ')}` : `HEAR PASS: ${rows.length} of ${rows.length} beats at WER <= 0.05`)
  return !bad.length
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const cmd = process.argv[2]
  if (cmd === 'say') await say(process.argv.includes('--dry'))
  else if (cmd === 'build') await build()
  else if (cmd === 'hear') process.exit((await hear()) ? 0 : 1)
  else { console.error('usage: voice.mjs say [--dry] | build | hear'); process.exit(2) }
}
