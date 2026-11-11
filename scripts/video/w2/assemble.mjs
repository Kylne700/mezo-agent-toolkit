// Stills + live clips + captions + the master voice track -> media/w2/w2-demo.mp4. Every number the video is held to is asserted here.
//   node assemble.mjs          builds the mp4 and checks it
//   node assemble.mjs frames   one frame per scene (and one at the end of the first 20 s) in media/w2/raw/frames
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DENYLIST } from '../config.mjs'
import { FONTS, H, OUT, RAW, STAGE_H, W, run } from './common.mjs'
import { MAX_S, MIN_S, REPAY_BY, STORY_BY, gate } from './narration.mjs'
import { key } from './screens.mjs'

const FPS = 25
const MP4 = join(OUT, 'w2-demo.mp4')
const FRAMES = join(RAW, 'frames')
const ff = (args) => run('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args])
const timing = JSON.parse(readFileSync(join(RAW, 'timing.json'), 'utf8'))
const live = JSON.parse(readFileSync(join(RAW, 'live/live.json'), 'utf8'))
const frames = (s) => Math.round(s * FPS)

// ---- asserts on the plan, before any encoding
const seg = (screen) => timing.segments.find((g) => g.screen === screen)
const fail = (m) => { throw new Error(`assemble: ${m}`) }
if (timing.total < MIN_S || timing.total > MAX_S) fail(`total ${timing.total.toFixed(1)} s is outside ${MIN_S}-${MAX_S} s`)
if (seg('repay').start >= REPAY_BY) fail(`the repay page starts at ${seg('repay').start.toFixed(1)} s, after ${REPAY_BY} s`)
if (seg('debt').start >= STORY_BY) fail(`the debt numbers start at ${seg('debt').start.toFixed(1)} s, after ${STORY_BY} s`)
if (seg('claim').start !== 0) fail('the claim page does not start at 0')
for (const g of timing.segments) if (g.end - g.start < 1.5) fail(`segment ${key(g)} is shorter than 1.5 s`)
for (const n of ['claim', 'repay']) if (seg(n).end - seg(n).start > live[n].seconds) fail(`${n} page is shown longer (${(seg(n).end - seg(n).start).toFixed(1)} s) than the live clip (${live[n].seconds} s)`)

if (process.argv[2] === 'frames') {
  mkdirSync(FRAMES, { recursive: true })
  const at = [...timing.segments.map((g) => [key(g), (g.start + g.end) / 2]), ['first20', STORY_BY - 0.1]]
  for (const [k, t] of at) await ff(['-ss', t.toFixed(2), '-i', MP4, '-frames:v', '1', join(FRAMES, `${k}.png`)])
  console.log(`frames: ${at.map((a) => a[0]).join(' ')}`)
  process.exit(0)
}

// ---- one clip per segment, cut on exact frame counts so the picture and the voice track stay in step
const clips = []
let cum = 0
mkdirSync(join(RAW, 'clips'), { recursive: true })
for (const [i, g] of timing.segments.entries()) {
  const end = i + 1 === timing.segments.length ? frames(timing.total) : frames(g.end)
  const n = end - cum
  cum = end
  const k = key(g)
  const out = join(RAW, 'clips', `${String(i).padStart(2, '0')}-${k}.mp4`)
  const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', '-frames:v', String(n)]
  if (live[g.screen]) await ff(['-i', live[g.screen].file, '-vf', `fps=${FPS},tpad=stop_mode=clone:stop_duration=2`, ...enc, out])
  else await ff(['-loop', '1', '-framerate', String(FPS), '-i', join(RAW, 'slides', `${k}.png`), '-vf', 'format=yuv420p', ...enc, out])
  clips.push(out)
}
writeFileSync(join(RAW, 'clips.txt'), clips.map((c) => `file '${c}'`).join('\n') + '\n')

// ---- captions: one cue per sentence, burned into the 96 px band under the picture
const t2 = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}` }
const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Cap,Inter,31,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,70,70,${Math.round((H - STAGE_H) / 2 - 22)},1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`
const cues = timing.sentences.map((s) => { gate(s.text, `caption ${s.id}`); return `Dialogue: 0,${t2(s.start)},${t2(s.end + 0.15)},Cap,,0,0,0,,${s.text.replace(/[{}\\]/g, '')}` })
const ass = join(RAW, 'captions.ass')
writeFileSync(ass, head + cues.join('\n') + '\n')

// ---- encode: stage picture + caption band + master voice, no metadata
await ff(['-f', 'concat', '-safe', '0', '-i', join(RAW, 'clips.txt'), '-i', join(RAW, 'master.wav'),
  '-vf', `pad=${W}:${H}:0:0:black,ass=${ass}:fontsdir=${FONTS}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '1', '-shortest', '-movflags', '+faststart', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', MP4])

// ---- checks on the file itself
const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_type,width,height,r_frame_rate', '-of', 'json', MP4])).stdout)
const secs = Number(probe.format.duration)
if (secs < MIN_S || secs > MAX_S) fail(`the mp4 is ${secs.toFixed(2)} s, outside ${MIN_S}-${MAX_S} s`)
if (Math.abs(secs - timing.total) > 0.3) fail(`the mp4 (${secs.toFixed(2)} s) and the plan (${timing.total.toFixed(2)} s) differ by more than 0.3 s`)
const v = probe.streams.find((s) => s.codec_type === 'video')
if (v.width !== W || v.height !== H) fail(`size ${v.width}x${v.height}`)
const extra = Object.keys(probe.format.tags ?? {}).filter((k) => !['major_brand', 'minor_version', 'compatible_brands'].includes(k)) // the three mp4 brand fields are structure, not metadata
if (extra.length) fail(`container tags: ${extra.join(',')}`)
const strings = (await run('strings', ['-n', '6', MP4])).stdout
const hit = await run('rg', ['-c', '-f', DENYLIST], { input: strings, ok: [0, 1] }) // never print a term: only whether there was a match
if (hit.code === 0) fail('privacy denylist matched strings in the mp4')
console.log(`ok: ${MP4} ${secs.toFixed(2)} s ${v.width}x${v.height}; story: repay page at ${seg('repay').start.toFixed(1)} s, debt numbers at ${seg('debt').start.toFixed(1)} s; denylist 0 matches`)
