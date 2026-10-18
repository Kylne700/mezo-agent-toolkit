// Assembles media/demo.mp4 from what the take (take.ts), tts.mjs and scenes.mjs left in media/raw:
//   the narration (one WAV per beat) -> audio/all.wav; the scene stills and the two filmed live pages -> one picture track of exactly the same length;
//   the burned-in captions (the printed text of every sentence) and a label on the live pages -> one ASS file drawn by libass with the self-hosted Inter.
// Every picture second is cut to the audio by frame number, counted from the beat starts of plan.json, so no rounding adds up.
// The live pages start at their sync flash: the magenta frames are found in the file, so the page clock and the video clock need no calibration.
// Run: node scripts/video/assemble.mjs   (writes media/demo.mp4 and media/raw/assemble.json; temporary files go to the OS temp folder)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_MAX_SECONDS, FONTS, FPS, H, MEDIA, RAW, W } from './config.mjs'
import { run, wavSamples } from './lib.mjs'

const STAGE_H = 624 // the picture above the 96 px caption band
const BAND = '0x05080c' // the colour of the band in the stills
const timing = JSON.parse(readFileSync(join(RAW, 'timing.json'), 'utf8'))
const plan = JSON.parse(readFileSync(join(RAW, 'scenes/plan.json'), 'utf8'))
const live = JSON.parse(readFileSync(join(RAW, 'live/live.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'mezo-assemble-'))
const OUT = join(MEDIA, 'demo.mp4')
const fr = (t) => Math.round(t * FPS) // frame number of a time on the timeline
const ff = (args) => run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args])
const esc = (p) => p.replace(/([\\:',[\]])/g, '\\$1') // a path inside an ffmpeg filter argument

// ---- audio: the beat WAVs end to end (each one already carries its own silence, so the sum is the timeline) -------------------------------------------
const wavs = timing.beats.map((b) => join(RAW, b.file))
const list = join(work, 'audio.txt')
writeFileSync(list, wavs.map((w) => `file '${w}'`).join('\n') + '\n')
const ALL = join(RAW, 'audio/all.wav')
await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ALL])
const audioSec = wavSamples(ALL) / 48000
const total = fr(plan.beats.at(-1).start + plan.beats.at(-1).dur) // frames of the whole picture
if (Math.abs(total / FPS - audioSec) > 0.05) throw new Error(`picture ${total / FPS} s and audio ${audioSec} s differ by more than 0.05 s`)
if (total / FPS > BUILD_MAX_SECONDS) throw new Error(`video would be ${total / FPS} s, over the build limit ${BUILD_MAX_SECONDS} s`)

// ---- the sync flash of a live page: the second (counted in 25 fps frames) where its last magenta frame ends ------------------------------------------
function markerEnd(webm) {
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', webm, '-vf', `fps=${FPS},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
  const magenta = (i) => px[3 * i] > 180 && px[3 * i + 2] > 180 && px[3 * i + 1] < 90
  const n = px.length / 3
  let a = 0
  while (a < n && !magenta(a)) a++
  let b = a
  while (b < n && magenta(b)) b++
  if (a >= n || b - a < 8 || b - a > 20) throw new Error(`no sync flash of 8-20 frames in ${webm} (found ${b - a} frames at ${a})`)
  return { firstFrame: a, frames: b - a, cutAt: (b + 1) / FPS, lengthSec: n / FPS } // one frame later, so a half-faded frame never shows
}

// ---- picture: one segment per beat, cut at frame boundaries -------------------------------------------------------------------------------------------
const marks = {}
const segs = []
const SEG = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS)] // near lossless: encoded once more at the end
for (const [i, b] of plan.beats.entries()) {
  const f0 = fr(b.start)
  const f1 = i + 1 < plan.beats.length ? fr(plan.beats[i + 1].start) : total
  const n = f1 - f0
  const out = join(work, `seg-${i}.mp4`)
  if (b.live) {
    const webm = join(RAW, live[b.live].file)
    const m = (marks[b.live] = markerEnd(webm))
    if (m.lengthSec < m.cutAt + n / FPS) throw new Error(`${b.live} clip is ${m.lengthSec} s: too short for ${n / FPS} s after the flash at ${m.cutAt} s`)
    // fps first (the recording only has frames where the page changed), then cut: the cut is exact even when no frame sits on the cut time
    const vf = `fps=${FPS},trim=start=${m.cutAt}:end=${m.cutAt + n / FPS},setpts=PTS-STARTPTS,crop=${W}:${STAGE_H}:0:0,pad=${W}:${H}:0:0:color=${BAND},` +
      'scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,format=yuv420p' // Playwright's VP8 is BT.601, the final file is tagged BT.709
    await ff(['-i', webm, '-vf', vf, '-frames:v', String(n), ...SEG, out])
  } else {
    const edges = [...b.steps.map((s) => fr(b.start + s.at)), f1]
    if (edges[0] !== f0) throw new Error(`beat ${b.id}: first step is not at the beat start`)
    const args = b.steps.flatMap((s, k) => ['-loop', '1', '-framerate', String(FPS), '-t', String((edges[k + 1] - edges[k]) / FPS), '-i', join(RAW, 'scenes', s.png)])
    const cat = b.steps.length > 1 ? `${b.steps.map((_, k) => `[${k}:v]`).join('')}concat=n=${b.steps.length}:v=1:a=0[c];[c]` : '[0:v]'
    await ff([...args, '-filter_complex', `${cat}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`, '-map', '[v]', '-frames:v', String(n), ...SEG, out])
  }
  segs.push({ id: b.id, frames: n, file: out })
}
const vlist = join(work, 'video.txt')
writeFileSync(vlist, segs.map((s) => `file '${s.file}'`).join('\n') + '\n')
const VIDEO = join(work, 'video.mp4')
await ff(['-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', VIDEO])

// ---- captions: the printed text of every sentence while it is spoken; a label on each live page -------------------------------------------------------
const ts = (t) => { const c = Math.round(t * 100); return `${Math.floor(c / 360000)}:${String(Math.floor(c / 6000) % 60).padStart(2, '0')}:${String(Math.floor(c / 100) % 60).padStart(2, '0')}.${String(c % 100).padStart(2, '0')}` }
const clean = (s) => s.replace(/[{}\\\n]/g, ' ')
const day = live.recordedAt.slice(0, 10)
const labels = {
  explorer: `Screen recording, Mezo testnet explorer, ${day} UTC`,
  console: `Screen recording, console of ${live.base}, ${day} UTC`,
}
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Cap,Inter SemiBold,34,&H00F5EEE8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,70,70,0,1',
  'Style: Chip,Inter SemiBold,20,&H00CFBCA9,&H000000FF,&H00352616,&H00000000,0,0,0,0,100,100,0,0,3,7,0,9,0,16,12,1', '',
  '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
]
const band = STAGE_H + (H - STAGE_H) / 2 // the middle of the band: one or two lines sit centred in it
for (const [i, b] of timing.beats.entries()) if (plan.beats[i].id !== b.id) throw new Error(`plan and timing disagree at beat ${i}: ${plan.beats[i].id} / ${b.id}`)
const caps = timing.beats.flatMap((b, i) => b.cues.map((c) => ({ t0: plan.beats[i].start + c.t0, t1: plan.beats[i].start + c.t1, text: c.text })))
for (const [k, c] of caps.entries()) {
  const end = Math.min(c.t1 + 0.15, caps[k + 1]?.t0 ?? Infinity) // held a moment after the last word, never over the next caption
  ass.push(`Dialogue: 0,${ts(c.t0)},${ts(end)},Cap,,0,0,0,,{\\pos(${W / 2},${band})}${clean(c.text)}`)
}
const cues = caps.length
for (const b of plan.beats) { // the label sits at the bottom right of the live page: there the pages hold nothing the narration points at
  if (b.live) ass.push(`Dialogue: 1,${ts(b.start)},${ts(b.start + b.dur)},Chip,,0,0,0,,{\\an3\\pos(${W - 16},${STAGE_H - 12})}${clean(labels[b.live])}`)
}
const ASS = join(work, 'captions.ass')
writeFileSync(ASS, ass.join('\n') + '\n')

// ---- the file: one encode, captions burned in, no metadata of its own ----------------------------------------------------------------------------------
mkdirSync(MEDIA, { recursive: true })
await ff([
  '-i', VIDEO, '-i', ALL,
  '-vf', `subtitles=filename=${esc(ASS)}:fontsdir=${esc(FONTS)}`,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart',
  OUT,
])
const info = { builtAt: new Date().toISOString(), out: 'media/demo.mp4', bytes: statSync(OUT).size, frames: total, seconds: total / FPS, audioSeconds: audioSec, cues, marks, segments: segs.map(({ id, frames }) => ({ id, frames })) }
writeFileSync(join(RAW, 'assemble.json'), JSON.stringify(info, null, 1))
rmSync(work, { recursive: true, force: true })
console.log(`demo.mp4: ${info.seconds.toFixed(2)} s picture, ${audioSec.toFixed(2)} s audio, ${(info.bytes / 1e6).toFixed(2)} MB, ${cues} captions; flash cut at explorer ${marks.explorer.cutAt} s, console ${marks.console.cutAt} s`)
