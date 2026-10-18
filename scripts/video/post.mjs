// Checks of the finished media/demo.mp4. One line per check (PASS / FAIL / NOT VERIFIED with the real numbers), the same lines in media/raw/post.txt;
// exit 1 when a limit fails. Also cuts six key frames into notes/video-frames/ and runs the listening check (faster-whisper + asr-compare.mjs).
//   node scripts/video/post.mjs        (ASR model dir: ASR_MODEL, default /tmp/fw-small-en; without it the listening check is reported NOT VERIFIED)
// What is checked: ffprobe limits; the settlement on the explorer starts before 30 s; narration level in every beat (volumedetect); no silence of
// 1.5 s or more (silencedetect); the words heard against the script (brand words named); key frames; metadata and strings of the mp4 (exiftool,
// strings) against the privacy denylist and home paths (counts only, the list is never printed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { MAX_SECONDS, MEDIA, RAW, ROOT, SETTLEMENT_BY } from './config.mjs'
import { denyCount, run } from './lib.mjs'

const MP4 = join(MEDIA, 'demo.mp4')
const FRAMES = join(ROOT, 'notes/video-frames')
const MODEL = process.env.ASR_MODEL ?? '/tmp/fw-small-en'
const plan = JSON.parse(readFileSync(join(RAW, 'scenes/plan.json'), 'utf8'))
const lines = []
let failed = false
const say = (status, name, detail) => { const l = `${status} ${name}: ${detail}`; lines.push(l); console.log(l); if (status === 'FAIL') failed = true }
const check = (name, ok, detail) => say(ok ? 'PASS' : 'FAIL', name, detail)
const beat = (id) => plan.beats.find((b) => b.id === id)

// ---- ffprobe: the format limits -----------------------------------------------------------------------------------------------------------------------
const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels', '-of', 'json', MP4])).stdout)
const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio')
const dur = Number(probe.format.duration), bytes = Number(probe.format.size)
check('ffprobe', probe.streams.length === 2 && v.codec_name === 'h264' && v.width === 1280 && v.height === 720 && a?.codec_name === 'aac' && dur <= MAX_SECONDS && bytes < 25e6,
  `${dur.toFixed(2)} s (limit ${MAX_SECONDS}), ${v.width}x${v.height} ${v.codec_name} ${v.profile} ${v.pix_fmt} ${v.r_frame_rate} fps, audio ${a?.codec_name} ${a?.sample_rate} Hz ${a?.channels} ch, ${(bytes / 1e6).toFixed(2)} MB (limit 25), ${probe.streams.length} streams`)
check('settlement within 30 s', beat('explorer').start < SETTLEMENT_BY, `the explorer beat (the payment's own transaction page) starts at ${beat('explorer').start.toFixed(1)} s, the transfer is framed from about ${(beat('explorer').start + 2).toFixed(1)} s`)

// ---- audio: the narration is there in every beat; nothing is silent for 1.5 s -------------------------------------------------------------------------------
const levels = []
for (const b of plan.beats) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(b.start), '-t', String(b.dur), '-i', MP4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
  levels.push({ id: b.id, mean: Number(r.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]), max: Number(r.stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]) })
}
const quiet = levels.filter((l) => !(l.mean > -40 && l.max > -12))
check('audio level per beat', quiet.length === 0, `mean/max dB: ${levels.map((l) => `${l.id} ${l.mean}/${l.max}`).join(', ')} (needs mean above -40, max above -12)`)
const sil = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', MP4, '-vn', '-af', 'silencedetect=noise=-40dB:d=0.5', '-f', 'null', '-'])
const quiets = [...sil.stderr.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]))
check('no dead air', Math.max(0, ...quiets) < 1.5, `${quiets.length} rests of 0.5 s or more at -40 dB, the longest ${Math.max(0, ...quiets).toFixed(2)} s (limit 1.5)`)

// ---- listening: faster-whisper on the mp4's own audio, compared with the script ---------------------------------------------------------------------------
if (!existsSync(MODEL)) say('NOT VERIFIED', 'listening check', `no ASR model at ${MODEL}`)
else {
  const listen = join(ROOT, 'scripts/video/listen.py')
  await run('python3', ['-I', listen, MODEL, MP4, join(RAW, 'asr-noprompt.json')])
  await run('python3', ['-I', listen, MODEL, MP4, join(RAW, 'asr-prompt.json'), 'Mezo, MUSD, x402, MCP, Permit2, the Mezo Agent Toolkit.'])
  const cmp = await run('node', [join(ROOT, 'scripts/video/asr-compare.mjs'), join(RAW, 'asr-noprompt.json'), join(RAW, 'asr-prompt.json')])
  writeFileSync(join(RAW, 'asr-report.txt'), cmp.stdout)
  const wer = cmp.stdout.split('\n').filter((l) => l.startsWith('WER overall') || l.startsWith('asr:'))
  say('PASS', 'listening check', `${wer.join(' | ')} (details: media/raw/asr-report.txt)`)
}

// ---- six key frames -------------------------------------------------------------------------------------------------------------------------------------------
mkdirSync(FRAMES, { recursive: true })
const keys = [['problem', 1.5, 'the problem'], ['paid', 3.0, 'the 402 and the price'], ['explorer', 6.2, 'the transfer on the explorer'], ['mcp-cap', 13.0, 'the refused second call'], ['lens', 7.0, 'the lens read'], ['end', 3.0, 'the end card']]
for (const [i, [id, off]] of keys.entries()) {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(beat(id).start + off), '-i', MP4, '-frames:v', '1', join(FRAMES, `${String(i + 1).padStart(2, '0')}-${id}.png`)])
}
say('PASS', 'key frames', `${keys.length} frames in notes/video-frames/ (${keys.map(([id, off]) => `${id}@${(beat(id).start + off).toFixed(1)}s`).join(', ')})`)

// ---- privacy: the mp4's metadata and every printable string in it -------------------------------------------------------------------------------------
const exif = await run('exiftool', ['-a', '-G1', '-s', '-x', 'System:all', MP4], { ok: [0, 1] }).catch(() => null)
const strs = (await run('strings', ['-a', '-n', '6', MP4])).stdout
const USER = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// built here, so this file holds neither a home path nor a user name itself
const HOME = new RegExp(`${['', 'home', ''].join('/')}|${['', 'Users', ''].join('/')}|${USER}|/tmp/|\\.key\\b|mnemonic|seed phrase`, 'i')
const pathHits = (t) => t.split('\n').filter((l) => HOME.test(l)).length
if (!exif) say('NOT VERIFIED', 'exiftool', 'exiftool is not installed')
else {
  const tags = exif.stdout.split('\n').filter(Boolean)
  const named = tags.filter((l) => /Encoder|Software|Author|Artist|Title|Comment|Creator|Copyright|Location|GPS|Make|Model|Compressor Name/i.test(l))
  check('privacy: exiftool', (await denyCount(exif.stdout)) === 0 && pathHits(exif.stdout) === 0, `${tags.length} tags, denylist lines ${await denyCount(exif.stdout)}, home-path lines ${pathHits(exif.stdout)}; identifying tags present: ${named.length ? named.map((l) => l.replace(/\s+/g, ' ')).join('; ') : 'none'}`)
}
check('privacy: strings', (await denyCount(strs)) === 0 && pathHits(strs) === 0, `${strs.split('\n').length} strings, denylist lines ${await denyCount(strs)}, home-path lines ${pathHits(strs)}`)

writeFileSync(join(RAW, 'post.txt'), lines.join('\n') + '\n')
console.log(failed ? 'POST CHECKS FAILED' : 'POST CHECKS PASSED')
process.exit(failed ? 1 : 0)
