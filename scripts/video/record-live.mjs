// Films the two live pages of the take with Playwright recordVideo (headless Chromium, no display): the explorer page of a payment and the Worker's console.
// Run by take.ts while the Worker is up (its env: BASE_URL, EXPLORER_URL of one transaction, CONSOLE_TX = the hashes of this take, comma separated).
// Writes media/raw/live/explorer.webm, console.webm and live.json (the second of the page where the scripted part starts, so the assembler cuts the loading off).
// Timings come from media/raw/timing.json, so what the page shows follows the narration: the explorer opens on the details, switches to the token transfers
// while the voice says "here is the transfer", and goes back to the details (the sender is the facilitator, not the agent) for "The agent paid no gas".
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHROMIUM, H, PW_BROWSERS, PW_CORE, RAW, W } from './config.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= PW_BROWSERS
const { chromium } = await import(pathToFileURL(join(PW_CORE, 'index.mjs')).href)
const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '')
const EXPLORER_URL = process.env.EXPLORER_URL ?? ''
const TXS = (process.env.CONSOLE_TX ?? '').split(',').filter(Boolean)
const OUT = join(RAW, 'live')
const timing = JSON.parse(readFileSync(join(RAW, 'timing.json'), 'utf8'))
const beat = (id) => {
  const b = timing.beats.find((x) => x.id === id)
  if (!b) throw new Error(`no beat ${id} in timing.json`)
  return b
}
const MARGIN = 3 // seconds of page kept after the beat ends, so the assembler never runs out of picture
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })

async function film(name, run) {
  const dir = join(OUT, `tmp-${name}`)
  rmSync(dir, { recursive: true, force: true })
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } }, locale: 'en-US', timezoneId: 'UTC' })
  const page = await ctx.newPage()
  const t0 = Date.now() // the video starts with the page, so the clock starts when the page exists (checked against the video's scene changes: within about 0.2 s)
  const info = { ok: false, note: '' }
  try { await run(page, info, () => (Date.now() - t0) / 1000) } catch (e) { info.ok = false; info.note = `${info.note} ${String(e.message).split('\n')[0]}`.trim() }
  const video = page.video()
  await ctx.close()
  const file = join(OUT, `${name}.webm`)
  renameSync(await video.path(), file)
  rmSync(dir, { recursive: true, force: true })
  info.lengthSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim())
  return { file: `live/${name}.webm`, ...info }
}

// A magenta flash of 0.5 s marks the moment the scripted part starts. The assembler finds it in the video and cuts everything up to its end, so the page
// clock and the video clock need no calibration (a cold first recording starts about a second late, a warm one does not) and the flash is never shown.
const flash = async (page) => {
  await page.evaluate(() => {
    const d = document.createElement('div')
    d.id = 'take-sync'
    d.style.cssText = 'position:fixed;inset:0;background:#ff00ff;z-index:2147483647'
    document.body.append(d)
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => document.getElementById('take-sync')?.remove())
}

// A red frame around the elements whose text matches (a needle like "/regex/" is a pattern), drawn as a fixed overlay; the page itself is not changed.
const frame = (page, texts) =>
  page.evaluate((needles) => {
    document.getElementById('take-frame')?.remove()
    const boxes = needles.flatMap((n) => {
      const test = n.startsWith('/') ? (t) => new RegExp(n.slice(1, -1)).test(t) : (t) => t === n
      const el = [...document.querySelectorAll('a, strong, div, span, td, p')].find((e) => e.children.length === 0 && test(e.textContent.trim()))
      return el ? [el.getBoundingClientRect()] : []
    })
    if (!boxes.length) return false
    const x0 = Math.min(...boxes.map((b) => b.left)) - 12, y0 = Math.min(...boxes.map((b) => b.top)) - 10
    const x1 = Math.max(...boxes.map((b) => b.right)) + 12, y1 = Math.max(...boxes.map((b) => b.bottom)) + 10
    const d = document.createElement('div')
    d.id = 'take-frame'
    d.style.cssText = `position:fixed;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px;border:3px solid #e5484d;border-radius:8px;pointer-events:none;z-index:99999`
    document.body.append(d)
    return true
  }, texts)
const unframe = (page) => page.evaluate(() => document.getElementById('take-frame')?.remove())

const explorer = await film('explorer', async (page, info, now) => {
  if (!EXPLORER_URL) throw new Error('no EXPLORER_URL')
  const hash = EXPLORER_URL.split('/tx/')[1]
  await page.goto(EXPLORER_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByText('Transaction details').first().waitFor({ timeout: 45_000 })
  await page.getByText(hash).first().waitFor({ timeout: 30_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  const b = beat('explorer')
  const t = (s) => b.timing[s].t0 // sentence starts within the beat
  await flash(page)
  info.readyMs = Math.round(now() * 1000)
  const at = async (sec) => { const wait = info.readyMs / 1000 + sec - now(); if (wait > 0) await page.waitForTimeout(wait * 1000) }
  await at(t(0) + 1.4) // "... here is the transfer on the explorer"
  await page.getByText('Token transfers', { exact: true }).first().click({ timeout: 10_000 })
  await page.getByText('Mezo USD').first().waitFor({ timeout: 15_000 })
  info.transfer = await frame(page, ['Mezo USD', '0.001'])
  info.marks = { tokenTab: Math.round(now() * 1000) }
  await at(t(1) - 0.1) // "The agent paid no gas."
  await unframe(page)
  await page.getByText('Details', { exact: true }).first().click({ timeout: 10_000 })
  await page.getByText('Transaction hash').first().waitFor({ timeout: 15_000 })
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(700)
  info.sender = await frame(page, ['From', '/^0x[0-9a-fA-F]{40}$/']) // the row "From": the facilitator that sent the transaction, not the agent
  info.marks.details = Math.round(now() * 1000)
  await at(b.dur + MARGIN)
  info.ok = info.transfer === true && info.sender === true
  info.note = `transfer tab ${info.transfer ? 'framed' : 'NOT found'}, sender row ${info.sender ? 'framed' : 'NOT found'}, ready at ${info.readyMs} ms`
})

const consolePage = await film('console', async (page, info, now) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('#payments li').length > 0, null, { timeout: 90_000 })
  const shorts = TXS.map((h) => `${h.slice(0, 10)}…${h.slice(-6)}`)
  const rows = await page.evaluate((s) => [...document.querySelectorAll('#payments li')].map((li) => ({ text: li.textContent, ours: s.some((x) => li.textContent.includes(x)) })), shorts)
  info.rows = rows.length
  info.found = rows.filter((r) => r.ours).length
  const b = beat('console')
  await flash(page)
  info.readyMs = Math.round(now() * 1000)
  const at = async (sec) => { const wait = info.readyMs / 1000 + sec - now(); if (wait > 0) await page.waitForTimeout(wait * 1000) }
  await at(1.0)
  await page.evaluate(() => document.getElementById('recent').scrollIntoView({ behavior: 'smooth', block: 'start' }))
  await at(2.0)
  await page.evaluate((s) => {
    const lis = [...document.querySelectorAll('#payments li')]
    const ours = lis.filter((li) => s.some((x) => li.textContent.includes(x)))
    for (const li of ours.length ? ours : lis.slice(0, 1)) li.style.outline = '3px solid #e5484d'
  }, shorts)
  await at(b.dur + MARGIN)
  info.ok = rows.length > 0 && info.found === TXS.length
  info.note = `${rows.length} payments listed, ${info.found} of ${TXS.length} from this take, ready at ${info.readyMs} ms`
})

await browser.close()
writeFileSync(join(OUT, 'live.json'), JSON.stringify({ recordedAt: new Date().toISOString(), base: new URL(BASE).host, explorer, console: consolePage }, null, 1))
console.log(`explorer: ${explorer.ok ? 'ok' : 'FAILED'} (${explorer.note}); console: ${consolePage.ok ? 'ok' : 'FAILED'} (${consolePage.note})`)
process.exit(explorer.ok && consolePage.ok ? 0 : 1)
