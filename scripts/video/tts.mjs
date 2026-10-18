// Narration -> audio. Reads scripts/video/narration.md, speaks every sentence with the voice picked by VOICE (config.mjs),
// joins the sentences of each beat with fixed silences, gains the whole track to -16 LUFS (true peak <= -1.5 dBTP)
// and writes one WAV per beat into media/raw/audio plus timing.json (sentence offsets, caption cues).
// Adapted from the author's own MIT-licensed Sealdrop video chain. Fails when the narration cannot fit the video limits (see config.mjs).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { BUILD_MAX_SECONDS, END_TAIL, GAP, RAW, SAY, SETTLEMENT_BY, TAIL, TOOLS, VOICE, VOICES } from './config.mjs'
import { round3, run, sha1, wavSamples } from './lib.mjs'
import { captionChunks, parseNarration, spoken, wordCount } from './narration.mjs'

const TAILS = {} // beats that linger longer than TAIL: none here
const FC_IN = resolve(RAW, 'audio')
const v = VOICES[VOICE]
if (!v) throw new Error(`VOICE=${VOICE} is not in the table (1-3 here, see tools/tts-samples/KEY.md)`)
const dir = resolve(RAW, 'tts', `v${VOICE}`)
mkdirSync(dir, { recursive: true })
mkdirSync(FC_IN, { recursive: true })
const ff = (args) => run('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args])
const A = ['-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1']

const steps = parseNarration()
const beats = steps.flatMap((s) => s.beats)
const jobs = beats.flatMap((b) => b.sentences.map((text, k) => ({ beat: b, k, text })))

async function speak(text, out) {
  const abs = (p) => resolve(TOOLS, p)
  const args = ['-I', SAY, '--engine', v.engine, '--model', abs(v.model)]
  if (v.engine === 'kokoro') args.push('--voices', abs(v.voices), '--voice', v.voice) // no --lang/--speed: the KEY.md command as written
  await run(abs(v.py), [...args, '--out', out], { input: spoken(text) + '\n' })
}

// one say.py call per sentence (exact durations for captions); results are cached by text + voice settings
let next = 0
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++]
    const key = sha1(JSON.stringify([v, spoken(j.text)]))
    j.raw = resolve(dir, `s-${key}.wav`)
    j.wav = resolve(dir, `s-${key}.48k.wav`)
    if (!existsSync(j.wav)) {
      await speak(j.text, j.raw)
      // trim the engine's lead/tail silence to a fixed 30/60 ms so GAP and TAIL alone set the pauses
      await ff(['-i', j.raw, '-af', 'silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.06:start_threshold=-45dB,areverse', ...A, j.wav])
    }
    j.samples = wavSamples(j.wav)
  }
}))

const silence = async (name, s) => { const p = resolve(dir, name); await ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(s), ...A, p]); return p }
const gapWav = await silence(`gap-${GAP}.wav`, GAP)
const gapN = Math.round(GAP * 48000)
const lastBeat = beats.at(-1)
const tailOf = (b) => (b === lastBeat ? END_TAIL : TAILS[b.id] ?? TAIL) // silence after the beat's last sentence, in seconds
const tailWavs = {}
for (const b of beats) tailWavs[tailOf(b)] ??= await silence(`tail-${tailOf(b)}.wav`, tailOf(b))

// ---- join each beat: sentence, gap, sentence, ..., tail (concat demuxer on identical PCM = no re-encode)
const lufs = {}
for (const b of beats) {
  const mine = jobs.filter((j) => j.beat === b)
  const list = mine.flatMap((j, i) => (i ? [gapWav, j.wav] : [j.wav])).concat(tailWavs[tailOf(b)])
  b.joined = resolve(dir, `beat-${b.id}.raw.wav`)
  const listFile = resolve(dir, `beat-${b.id}.txt`)
  writeFileSync(listFile, list.map((f) => `file '${f}'`).join('\n') + '\n')
  await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', b.joined])
  let at = 0
  b.timing = mine.map((j, i) => {
    if (i) at += gapN
    const t0 = at / 48000
    at += j.samples
    return { text: j.text, t0: round3(t0), t1: round3(at / 48000) }
  })
  b.dur = round3((at + Math.round(tailOf(b) * 48000)) / 48000)
}

// ---- level: one linear gain for the whole track, so every beat keeps its relative loudness
const master = resolve(dir, 'master.raw.wav')
const masterList = resolve(dir, 'master.txt')
writeFileSync(masterList, beats.map((b) => `file '${b.joined}'`).join('\n') + '\n')
await ff(['-f', 'concat', '-safe', '0', '-i', masterList, '-c', 'copy', master])
const m = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', master, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'])
const j = JSON.parse(m.stderr.slice(m.stderr.lastIndexOf('{'), m.stderr.lastIndexOf('}') + 1))
let gain = -16 - Number(j.input_i)
if (Number(j.input_tp) + gain > -1.5) gain = -1.5 - Number(j.input_tp)
for (const b of beats) {
  b.file = resolve(FC_IN, `narr-${b.id}.wav`)
  await ff(['-i', b.joined, '-af', `volume=${gain.toFixed(2)}dB`, ...A, b.file])
}

// ---- caption cues: each sentence is cut at commas/colons (captionChunks). A cut that follows a pause in the speech is placed in that
// pause (silencedetect on the sentence's own WAV: the voice rests 0.4 to 1 s at a colon or comma, so a share by character count alone
// ran up to 0.8 s early). Between two such anchors the time is still shared by character count.
const PAUSE_MIN = 0.2 // s, a rest shorter than this is a plosive or a breath, not a comma
const SKIP = 0.7 // s, cost of a pause with no comma or a comma with no pause in the matching below
async function pausesOf(wav, dur) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', wav, '-af', `silencedetect=noise=-38dB:d=${PAUSE_MIN}`, '-f', 'null', '-'])
  const out = []
  for (const l of r.stderr.split('\n')) {
    const a = l.match(/silence_start: ([\d.]+)/), b = l.match(/silence_end: ([\d.]+)/)
    if (a) out.push({ a: Number(a[1]) })
    else if (b && out.length) out.at(-1).b = Number(b[1])
  }
  return out.filter((p) => p.b !== undefined && p.a > 0.1 && p.b < dur - 0.1)
}

/** Caption cues of one sentence ([{text, t0, t1}], seconds from the sentence start). */
function cuesOf(text, dur, pauses) {
  // lengths are counted in what the voice says (a path spelled out takes longer than it prints), not in what the caption shows
  const heard = (t) => spoken(t).replace(/\d+/g, (d) => 'x'.repeat(d.length === 1 ? 4 : 9)) // a number takes as long as its words (31 = thirty-one)
  const chunks = captionChunks(text), len = chunks.map((c) => heard(c).length), n = len.reduce((k, x) => k + x, 0)
  const ends = len.map((_, i) => len.slice(0, i + 1).reduce((k, x) => k + x, 0)) // offset where each chunk ends
  const marks = chunks.flatMap((c, k) => [...c].flatMap((ch, i) => (',:;'.includes(ch) || (ch === '.' && !/\d/.test(c[i + 1] ?? '') && !(k === chunks.length - 1 && i === c.length - 1)) ? [(ends[k] - len[k]) + heard(c.slice(0, i + 1)).length] : [])))
  // which comma each pause belongs to: monotonic matching of the pause's place in speech time with the comma's place by character count
  const speech = dur - pauses.reduce((k, p) => k + p.b - p.a, 0)
  let rested = 0
  const at = pauses.map((p) => { const u = p.a - rested; rested += p.b - p.a; return u })
  const want = marks.map((c) => (speech * c) / n)
  const best = Array.from({ length: pauses.length + 1 }, () => new Array(marks.length + 1).fill(0)), via = best.map((r) => r.map(() => ''))
  for (let i = 0; i <= pauses.length; i++) for (let j = 0; j <= marks.length; j++) {
    if (!i && !j) continue
    const opt = []
    if (i) opt.push([best[i - 1][j] + SKIP, 'p'])
    if (j) opt.push([best[i][j - 1] + SKIP, 'm'])
    if (i && j && Math.abs(at[i - 1] - want[j - 1]) < 2 * SKIP) opt.push([best[i - 1][j - 1] + Math.abs(at[i - 1] - want[j - 1]), 'x'])
    ;[best[i][j], via[i][j]] = opt.reduce((a, b) => (b[0] < a[0] ? b : a))
  }
  const anchors = [{ c: 0, s: 0, e: 0 }] // c: character offset; e: when the cue before it ends, s: when the cue after it starts
  const found = []
  for (let i = pauses.length, j = marks.length; i || j;) {
    const v = via[i][j]
    if (v === 'x') { const p = pauses[--i], half = Math.min(0.25, (p.b - p.a) / 2); found.push({ c: marks[--j], e: p.a + half, s: p.b - half }) } else if (v === 'p') i--; else j--
  }
  anchors.push(...found.reverse(), { c: n, s: dur, e: dur })
  const time = (c, side) => {
    const hit = anchors.find((a) => a.c === c)
    if (hit) return hit[side]
    const k = anchors.findIndex((a) => a.c > c), a = anchors[k - 1], b = anchors[k]
    return a.s + ((b.e - a.s) * (c - a.c)) / (b.c - a.c)
  }
  const cues = chunks.map((t, k) => ({ text: t, t0: k ? time(ends[k - 1], 's') : 0, t1: k < chunks.length - 1 ? time(ends[k], 'e') : dur }))
  // a mismatch (a cue under half a second, or out of order) falls back to the plain share by character count
  if (cues.some((c) => c.t1 - c.t0 < 0.5) && chunks.length > 1) {
    let t = 0
    return chunks.map((text, k) => { const t0 = t; t += (dur * len[k]) / n; return { text, t0, t1: t } })
  }
  return cues
}

for (const b of beats) {
  const mine = jobs.filter((j) => j.beat === b)
  b.cues = []
  for (const [i, s] of b.timing.entries()) {
    const dur = s.t1 - s.t0
    for (const c of cuesOf(s.text, dur, await pausesOf(mine[i].wav, dur))) b.cues.push({ text: c.text, t0: round3(s.t0 + c.t0), t1: round3(s.t0 + c.t1) })
  }
}

const out = { voice: VOICE, label: v.label, speed: 'say.py default (1.0)', gain_db: round3(gain), measured: { i: j.input_i, tp: j.input_tp, lra: j.input_lra },
  beats: beats.map((b) => ({ id: b.id, step: b.step, file: relative(RAW, b.file), dur: b.dur, timing: b.timing, cues: b.cues })) }
writeFileSync(resolve(dir, 'timing.json'), JSON.stringify(out, null, 1))
copyFileSync(resolve(dir, 'timing.json'), resolve(RAW, 'timing.json'))
const total = beats.reduce((n, b) => n + b.dur, 0)
console.log(`tts: voice ${VOICE} (${v.label}), ${wordCount(steps)} words, ${beats.length} beats, ${total.toFixed(1)} s of narration incl. pauses, gain ${gain.toFixed(2)} dB (in: ${j.input_i} LUFS, ${j.input_tp} dBTP)`)
for (const s of steps) console.log(`  step ${s.n} ${s.title}: ${s.beats.reduce((n, bb) => n + beats.find((x) => x.id === bb.id).dur, 0).toFixed(1)} s`)
// the video limits, checked where they first become known
const explorerAt = beats.slice(0, beats.findIndex((b) => b.id === 'explorer')).reduce((n, b) => n + b.dur, 0)
console.log(`  the explorer beat (the settlement, checkable) starts at ${explorerAt.toFixed(1)} s; total ${total.toFixed(1)} s`)
if (total > BUILD_MAX_SECONDS) throw new Error(`narration is ${total.toFixed(1)} s, over the ${BUILD_MAX_SECONDS} s build limit: shorten scripts/video/narration.md`)
if (!(explorerAt < SETTLEMENT_BY)) throw new Error(`the explorer beat starts at ${explorerAt.toFixed(1)} s, not before ${SETTLEMENT_BY} s: shorten the beats before it`)
