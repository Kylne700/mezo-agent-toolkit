// Listening check, part 2: compares a faster-whisper transcript of the final mix (scripts/video/listen.py) with the narration
// (the printed sentences in media/raw/timing.json). Adapted from the author's own MIT-licensed Sealdrop video chain.
//   node scripts/video/asr-compare.mjs <asr.json> [<asr-with-prompt.json>]
// Prints the word error rate overall, per story step and per beat, every word heard differently, every occurrence of the brand words
// (Mezo, MUSD, x402, MCP, Permit2, Kylne700) and the caption drift against the ASR word times. Beats start at the sum of the beat lengths.
// Normalisation (both sides): lower case; the brand words are first folded to one token (MUSD = M USD = M U S D, x402 = x four oh two,
// Permit2 = Permit two, MCP = M C P ...); hyphens, slashes and punctuation become spaces; apostrophes are dropped; digits become words.
// A word heard as another word (Mezo as Mesa) stays an error. Alignment: word-level edit distance.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RAW } from './config.mjs'

const [asrFile, promptFile] = process.argv.slice(2)
if (!asrFile) throw new Error('usage: node scripts/video/asr-compare.mjs <asr.json> [<asr-with-prompt.json>]')
const timing = JSON.parse(readFileSync(resolve(RAW, 'timing.json'), 'utf8'))
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS = 'x x twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
const num = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)
const COMPOUNDS = { readme: 'read me', githubs: 'github' }
const SPELLING = {}
// the brand words, folded to one token whichever way they are printed or heard: [folded, ...token sequences that all mean it].
// "permit to" / "permit too" are homophones of "Permit two" (the audio says two); they are folded and counted, and the report names the count.
const MERGES = [
  ['xfouroh2', 'x four oh two', 'x four o two', 'x four zero two', 'x 402'],
  ['fouroh2', 'four oh two', 'four o two', 'four zero two', '402'],
  ['musd', 'm u s d', 'm usd', 'musd'],
  ['mcp', 'm c p', 'mcp'],
  ['permit2', 'permit two', 'permit to', 'permit too'],
  ['url', 'u r l', 'url'],
  ['zeropoint001', 'zero point zero zero one', 'zero zeropoint001', 'zeropoint001'],
  ['testnet', 'test net', 'testnet'],
  ['october18', 'october eighteen th', 'october eighteenth', 'october eighteen'],
]
const SEQS = MERGES.flatMap(([to, ...froms]) => froms.map((f) => [f.split(' '), to])).sort((x, y) => y[0].length - x[0].length)
let homophones = 0
/** Folds token sequences ([{w, start?, end?}]) into brand tokens; a folded token spans from the first token's start to the last one's end. */
function merge(toks, count = false) {
  const out = []
  for (let i = 0; i < toks.length;) {
    const hit = SEQS.find(([seq]) => seq.every((w, k) => toks[i + k]?.w === w))
    if (!hit) { out.push(toks[i++]); continue }
    if (count && (hit[0].includes('to') || hit[0].includes('too'))) homophones++
    out.push({ ...toks[i], w: hit[1], end: toks[i + hit[0].length - 1].end })
    i += hit[0].length
  }
  return out
}

/** One string to tokens, before the brand folds: lower case; letters and digits split apart (0.001MUSD, x402); hyphens and punctuation
 *  become spaces; apostrophes are dropped; one- and two-digit numbers become words. */
function tok(text) {
  return text.toLowerCase().replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/(?<![\d])0?\.001\b/g, ' zeropoint001 ')
    .replace(/[‐-―/-]/g, ' ').replace(/'/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((t) => (/^\d{1,2}$/.test(t) ? num(Number(t)) : t))
    .flatMap((t) => (COMPOUNDS[t] ?? SPELLING[t] ?? t).split(' '))
}
const norm = (text) => merge(tok(text).map((w) => ({ w }))).map((t) => t.w)

/** Edit-distance alignment: ops[k] = { r: ref index | -1, h: hyp index | -1 }. */
function align(ref, hyp) {
  const n = ref.length, m = hyp.length
  const d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
  const ops = []
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) ops.push({ r: --i, h: --j })
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) ops.push({ r: --i, h: -1 })
    else ops.push({ r: -1, h: --j })
  }
  return ops.reverse()
}

// ---- reference: beat by beat, with the start of each beat in the video -----------------------------------------
// assemble.mjs cuts every beat to exactly its narration length, so a beat starts at the sum of the durations before it.
const real = null
let start = 0
const refTok = [] // { w, beat, i }
const beats = timing.beats.map((b, k) => {
  const first = refTok.length
  for (const s of b.timing) for (const w of norm(s.text)) refTok.push({ w, beat: b.id })
  const info = { id: b.id, step: b.step, start: real?.[k] ?? start, first, last: refTok.length, cues: [] }
  start += b.dur
  return info
})
timing.beats.forEach((b, k) => { // caption cues: consecutive slices of the beat's tokens
  let at = beats[k].first
  for (const c of b.cues) { const n = norm(c.text).length; beats[k].cues.push({ text: c.text, t0: beats[k].start + c.t0, t1: beats[k].start + c.t1, from: at, to: at + n }); at += n }
})

function analyse(file) {
  const asr = JSON.parse(readFileSync(resolve(file), 'utf8'))
  homophones = 0
  const hypTok = merge(asr.words.flatMap((x) => tok(x.w).map((w) => ({ w, start: x.start, end: x.end }))), true)
  const ops = align(refTok.map((t) => t.w), hypTok.map((t) => t.w))
  const per = new Map(beats.map((b) => [b.id, { n: b.last - b.first, S: 0, D: 0, I: 0 }]))
  const diffs = [] // { beat, ref, heard }
  const refToHyp = new Array(refTok.length).fill(-1)
  let lastBeat = beats[0].id
  for (const { r, h } of ops) {
    if (r >= 0) lastBeat = refTok[r].beat
    const p = per.get(lastBeat)
    if (r >= 0 && h >= 0) { refToHyp[r] = h; if (refTok[r].w !== hypTok[h].w) { p.S++; diffs.push({ beat: lastBeat, ref: refTok[r].w, heard: hypTok[h].w }) } }
    else if (r >= 0) { p.D++; diffs.push({ beat: lastBeat, ref: refTok[r].w, heard: '(nothing)' }) }
    else { p.I++; diffs.push({ beat: lastBeat, ref: '(nothing)', heard: hypTok[h].w }) }
  }
  return { asr, hypTok, per, diffs, refToHyp, ops, homo: homophones }
}

const wer = (p) => (p.S + p.D + p.I) / p.n
const pct = (x) => `${(100 * x).toFixed(1)}%`
function totals(per, ids) { const t = { n: 0, S: 0, D: 0, I: 0 }; for (const id of ids) for (const k of Object.keys(t)) t[k] += per.get(id)[k]; return t }
const raw = analyse(asrFile)
const withPrompt = promptFile ? analyse(promptFile) : null
const out = []
const say = (s = '') => { out.push(s); console.log(s) }

say(`asr: ${raw.asr.words.length} words heard in ${raw.asr.duration} s; reference ${refTok.length} words in ${beats.length} beats`)
const all = totals(raw.per, beats.map((b) => b.id))
say(`WER overall (no prompt): ${pct(wer(all))}  (${all.S} substituted, ${all.D} missing, ${all.I} extra, of ${all.n})`)
if (withPrompt) { const t = totals(withPrompt.per, beats.map((b) => b.id)); say(`WER overall (prompt with the brand words): ${pct(wer(t))}  (${t.S} substituted, ${t.D} missing, ${t.I} extra)`) }
say(`homophone folds ("permit to" heard for "Permit two", counted as right): ${raw.homo} (no prompt)${withPrompt ? `, ${withPrompt.homo} (with prompt)` : ''}`)
say('\nper story step:')
for (const s of [...new Set(beats.map((b) => b.step))]) {
  const ids = beats.filter((b) => b.step === s).map((b) => b.id), t = totals(raw.per, ids), tp = withPrompt && totals(withPrompt.per, ids)
  say(`  step ${s}: ${pct(wer(t))} (${t.S}S ${t.D}D ${t.I}I of ${t.n})${tp ? `   with prompt ${pct(wer(tp))}` : ''}`)
}
say('\nper beat (no prompt | with prompt):')
for (const b of beats) {
  const p = raw.per.get(b.id), q = withPrompt?.per.get(b.id)
  say(`  ${b.id.padEnd(9)} ${String(p.n).padStart(3)} words  ${pct(wer(p)).padStart(6)}  ${p.S}S ${p.D}D ${p.I}I${q ? `   | ${pct(wer(q)).padStart(6)}  ${q.S}S ${q.D}D ${q.I}I` : ''}`)
}
const listDiffs = (label, r) => {
  say(`\nwords heard differently (${label}):`)
  const g = new Map()
  for (const d of r.diffs) { const k = `${d.ref} -> ${d.heard}`; (g.get(k) ?? g.set(k, []).get(k)).push(d.beat) }
  for (const [k, v] of g) say(`  ${k}   x${v.length}  (${[...new Set(v)].join(', ')})`)
}
listDiffs('no prompt', raw)
if (withPrompt) listDiffs('with prompt', withPrompt)

say('\nbrand words, every occurrence in the narration (reference -> what was heard, no prompt | with prompt):')
const brand = ['mezo', 'musd', 'xfouroh2', 'mcp', 'permit2', 'kylne700', 'fouroh2', 'url', 'x', 'github', 'testnet', 'facilitator']
const heardAt = (r, i) => (r.refToHyp[i] >= 0 ? r.hypTok[r.refToHyp[i]].w : '(nothing)')
for (const w of brand) {
  const idx = refTok.map((t, i) => (t.w === w ? i : -1)).filter((i) => i >= 0)
  if (idx.length) say(`  ${w.padEnd(11)} ${idx.map((i) => `${refTok[i].beat}:${heardAt(raw, i)}${withPrompt ? `|${heardAt(withPrompt, i)}` : ''}`).join('  ')}`)
}

// caption drift: when a caption appears/disappears against the first/last word of its cue as heard
const drift = []
for (const b of beats) for (const c of b.cues) {
  const hit = []
  for (let i = c.from; i < c.to; i++) if (raw.refToHyp[i] >= 0) hit.push(raw.hypTok[raw.refToHyp[i]])
  if (!hit.length) { drift.push({ beat: b.id, text: c.text, none: true }); continue }
  drift.push({ beat: b.id, text: c.text, ds: c.t0 - hit[0].start, de: c.t1 - hit.at(-1).end, h0: hit[0], h1: hit.at(-1) })
}
const ds = drift.filter((d) => !d.none)
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const shift = med(ds.map((d) => d.ds))
say(`\ncaption drift (${ds.length} captions, caption time minus heard time; positive = the caption is late). Median start offset ${shift.toFixed(2)} s.`)
const worst = (k) => ds.reduce((m, d) => (Math.abs(d[k]) > Math.abs(m[k]) ? d : m), ds[0])
say(`  largest |start| ${Math.abs(worst('ds').ds).toFixed(2)} s (${worst('ds').beat}: "${worst('ds').text}")`)
say(`  largest |end|   ${Math.abs(worst('de').de).toFixed(2)} s (${worst('de').beat}: "${worst('de').text}")`)
const over = ds.filter((d) => Math.abs(d.ds) > 0.5 || Math.abs(d.de) > 0.5)
say(`  captions beyond 0.5 s: ${over.length} of ${ds.length}${drift.length - ds.length ? `; ${drift.length - ds.length} cue(s) with no aligned word` : ''}`)
for (const d of over) say(`    ${d.beat.padEnd(9)} start ${d.ds.toFixed(2)} end ${d.de.toFixed(2)}  "${d.text}"  (first word heard "${d.h0.w}" at ${d.h0.start.toFixed(2)}, last "${d.h1.w}" to ${d.h1.end.toFixed(2)})`)
writeFileSync(resolve(RAW, 'asr-report.txt'), `${out.join('\n')}\n`)
