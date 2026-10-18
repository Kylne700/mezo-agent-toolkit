// Counts the exact text inside each fenced block of SUBMISSION.md and checks it against the heading, the allowed range and a few format rules.
// Usage: node scripts/check-submission.mjs [--fix]   (--fix rewrites the "(N characters" part of each heading)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FILE = `${ROOT}/SUBMISSION.md`
const fix = process.argv.includes('--fix')
let md = readFileSync(FILE, 'utf8')
const lines = md.split('\n')
const fields = []
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^## (\d+)\. (.+?) \(([\d,]+) characters(?:; ([^)]*))?\)$/)
  if (!m) continue
  let j = i + 1
  while (j < lines.length && !lines[j].startsWith('```')) j++
  let k = j + 1
  while (k < lines.length && !lines[k].startsWith('```')) k++
  const text = lines.slice(j + 1, k).join('\n')
  fields.push({ line: i, n: Number(m[1]), name: m[2], said: Number(m[3].replace(/,/g, '')), note: m[4] ?? '', text })
}
const fmt = (n) => n.toLocaleString('en-US')
let bad = 0
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`) }
for (const f of fields) {
  const len = f.text.length
  if (fix && len !== f.said) {
    lines[f.line] = lines[f.line].replace(/\(([\d,]+) characters/, `(${fmt(len)} characters`)
    f.said = len
  }
  const range = f.note.match(/allowed (?:up to ([\d,]+)|([\d,]+)-([\d,]+))/)
  const lo = range?.[2] ? Number(range[2].replace(/,/g, '')) : 0
  const hi = range ? Number((range[1] ?? range[3]).replace(/,/g, '')) : Infinity
  say(len === f.said && len >= lo && len <= hi, `${String(f.n).padStart(2)} ${f.name}: ${len} chars (heading says ${f.said}${range ? `; allowed ${lo || 0}-${hi}` : ''})`)
}
if (fix) { md = lines.join('\n'); writeFileSync(FILE, md); console.log('headings rewritten') }

const by = (n) => fields.find((f) => f.n === n)
const words = by(2).text.trim().split(/\s+/).length
say(words >= 3 && words <= 5, `category has ${words} words (3-5)`)
say((by(3).text.match(/[.!?](\s|$)/g) ?? []).length === 1, 'TL;DR is one sentence')
say(!/[^\x00-\x7f]/.test(md), 'SUBMISSION.md is plain ASCII (no em dash, no smart quote)')
say(!/[<>]/.test(by(15).text + by(16).text), 'no angle brackets in the YouTube title and description')
const ph = ['{{REPO_URL}}', '{{LIVE_URL}}', '{{VIDEO_URL}}', '{{DECK_URL}}']
say(ph.every((p) => md.includes(p)), 'all four placeholders are used')
say(!/\{\{(?!REPO_URL|LIVE_URL|VIDEO_URL|DECK_URL)/.test(md), 'no other {{placeholder}}')
say(by(7).text === 'Track 2 Access & Distribution' && by(8).text === 'Mezo testnet 31611' && by(9).text === 'new' && by(10).text === 'testnet', 'fixed fields have the exact values')
say(/Kylne700/.test(by(12).text) && /solo/.test(by(12).text), 'team says Kylne700, solo')
say(!/mainnet/i.test(md.replace(/Nothing here calls Mezo mainnet\./g, '').replace(/Nothing here calls Mezo mainnet/g, '')) , 'mainnet appears only in "Nothing here calls Mezo mainnet"')
say(!/\bmain-?net (launch|deploy|payments)|will (go|launch|deploy)/i.test(md), 'no mainnet promise wording')

// every address and hash must exist in a source file
// media/raw is gitignored: take.json is read only where the take is present
const srcs = ['README.md', 'media/raw/take.json', 'evidence/video-take-2026-10-18.log'].filter((p) => existsSync(`${ROOT}/${p}`)).map((p) => readFileSync(`${ROOT}/${p}`, 'utf8')).join('\n')
const hexes = [...new Set(md.match(/0x[0-9a-fA-F]{40,64}/g) ?? [])]
for (const h of hexes) say(srcs.includes(h), `source has ${h.slice(0, 10)}...${h.slice(-6)} (${h.length - 2} hex)`)

// placeholders replaced by links of realistic and worst-case length
const sub = (t, n) => ph.reduce((s, p) => s.split(p).join('h'.repeat(n)), t)
const real = { '{{REPO_URL}}': 46, '{{LIVE_URL}}': 60, '{{VIDEO_URL}}': 28, '{{DECK_URL}}': 100 }
const subReal = (t) => Object.entries(real).reduce((s, [p, n]) => s.split(p).join('h'.repeat(n)), t)
for (const n of [13, 14, 16]) {
  const f = by(n)
  const rangeOf = f.note.match(/allowed (?:up to ([\d,]+)|([\d,]+)-([\d,]+))/)
  const hi = Number((rangeOf[1] ?? rangeOf[3]).replace(/,/g, '')), lo = rangeOf[2] ? Number(rangeOf[2].replace(/,/g, '')) : 0
  const a = subReal(f.text).length, b = sub(f.text, 100).length
  say(a >= lo && a <= hi && b >= lo && b <= hi, `${f.name}: ${a} with realistic links, ${b} with four 100-character links (limit ${hi})`)
}
console.log(bad ? `${bad} PROBLEM(S)` : 'ALL OK')
process.exit(bad ? 1 : 0)
