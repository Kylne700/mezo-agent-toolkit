// The pictures of the Wave 2 video. Slides: HTML drawn from facts.json, rendered to PNG with headless Chromium. Live pages: the two explorer
// transactions of Proof 1, filmed with Playwright recordVideo (headless, no display, free reads). Usage: node screens.mjs slides|live
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FONTS, OUT, RAW, STAGE_H, W, browser, run } from './common.mjs'
import { gate, script } from './narration.mjs'

const SLIDES = join(RAW, 'slides')
const LIVE = join(RAW, 'live')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const key = (s) => (s.variant ? `${s.screen}-${s.variant}` : s.screen)

const CSS = `
@font-face{font-family:Inter;font-weight:400;src:url(file://${FONTS}/Inter-Regular.otf)}
@font-face{font-family:Inter;font-weight:600;src:url(file://${FONTS}/Inter-SemiBold.otf)}
@font-face{font-family:Inter;font-weight:700;src:url(file://${FONTS}/Inter-Bold.otf)}
@font-face{font-family:JBM;font-weight:400;src:url(file://${FONTS}/JetBrainsMono-Regular.ttf)}
@font-face{font-family:JBM;font-weight:700;src:url(file://${FONTS}/JetBrainsMono-Bold.ttf)}
*{box-sizing:border-box;margin:0}
body{width:${W}px;height:${STAGE_H}px;background:#0d1117;color:#e6edf3;font:400 26px/1.3 Inter,sans-serif;padding:34px 48px;position:relative;overflow:hidden}
h1{font:700 36px/1.15 Inter,sans-serif;color:#fff;margin-bottom:6px}
.sub{color:#8b98a5;font-size:20px;margin-bottom:22px}
.mono{font-family:JBM,monospace}
.src{position:absolute;left:48px;right:48px;bottom:16px;font:400 17px/1.3 JBM,monospace;color:#7d8590}
.dim{opacity:.28}.hl{background:#16324a;border-left:6px solid #3fb950}
.ok{color:#3fb950}.warn{color:#f0883e}.bad{color:#ff7b72}.blue{color:#79c0ff}
`
const html = (body) => `<!doctype html><meta charset=utf-8><style>${CSS}</style><body>${body}</body>`
const frame = (title, sub, body, src) => html(`<h1>${esc(title)}</h1><div class=sub>${esc(sub)}</div>${body}<div class=src>${esc(src)}</div>`)

const SLIDE = {
  debt: (f) => {
    const c = f.chain
    const row = (label, val, cls = '') => `<div style="margin:0 0 14px"><div style="color:#8b98a5;font-size:21px">${esc(label)}</div><div class="mono ${cls}" style="font-size:40px;font-weight:700">${esc(val)} <span style="font-size:24px">MUSD</span></div></div>`
    return frame('Proof 1: claim, then repay with the claim', 'Mezo testnet, 2026-11-05. The numbers are read from the evidence files.',
      row('Trove debt before the repay', c.debtBefore) + row('Claimed fees, repaid in full by trove_repay', c.claimed, 'ok') + row('Trove debt after the repay', c.debtAfter, 'blue') +
      `<div class=mono style="font-size:17px;color:#8b98a5;margin-top:6px">claim ${esc(c.claim.hash)} block ${esc(c.claim.block)}<br>repay ${esc(c.repay.hash)} block ${esc(c.repay.block)}</div>`,
      `evidence/w2/claim1-w2-prove.txt L${c.debtLine}; claim1-fees.txt; claim1-repay.txt`)
  },
  tools: (f, v) => {
    const t = f.tools
    const col = (title, names, cls, extra = '') => `<div class="${cls}" style="padding:10px 18px;width:560px"><div style="font-weight:700;font-size:25px;margin-bottom:8px">${esc(title)}</div>${names.map((n) => `<div class=mono style="font-size:20px;line-height:25px">${esc(n)}</div>`).join('')}${extra}</div>`
    const left = col(`${t.reads.length} free reads`, t.reads, v === 'writes' ? 'dim' : 'hl', `<div class=mono style="font-size:17px;line-height:22px;margin-top:8px;color:#8b98a5">+ ${esc(t.paid)}: a paid call, needs a wallet</div>`)
    const right = col(`${t.writes.length} guarded writes: off unless ${t.writeEnv}`, t.writes, v === 'reads' ? 'dim' : 'hl')
    return frame('The MCP tool list', 'Listed by a real server session over stdio, twice: default environment, then with the write switch and no wallet.', `<div style="display:flex;gap:28px">${left}${right}</div>`,
      'tools/list of src/mcp.ts over stdio (no key file was set in either session)')
  },
  refused: (f) => {
    const t = f.tools
    const args = JSON.stringify(t.call.arguments)
    return frame('A write with the switch off', 'Default environment: no write switch, no wallet. The call was made by an MCP client against the real server.',
      `<div class=mono style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:26px 30px;font-size:25px;line-height:1.7">` +
      `<div class=blue>tools/list -> ${t.reads.length + 1} tools, no write tool among them</div>` +
      `<div style="margin-top:14px">tools/call ${esc(t.call.name)} ${esc(args)}</div>` +
      `<div class=bad style="margin-top:6px">${esc(t.refusal.text)}</div></div>` +
      `<div style="margin-top:22px;color:#8b98a5;font-size:21px">Nothing was sent and no key was loaded. With ${esc(t.writeEnv)} and no wallet, the ${t.writes.length} write tools are listed.</div>` +
      `<div style="margin-top:14px;color:#8b98a5;font-size:21px">${esc(t.paid)} is a separate tool: it pays only when a wallet key file is set, within the operator limits.</div>`,
      'scripts/video/w2/facts.mjs (the session), src/mcp-env.ts')
  },
  fixes: (f, v) => {
    const rows = f.fixes.map((x) => {
      const state = v === 'none' || v === 'all' ? '' : v === x.id ? 'hl' : 'dim'
      return `<div class="${state}" style="padding:10px 16px;margin-bottom:12px"><div style="font-size:25px;font-weight:700"><span class="${x.severity === 'High' ? 'bad' : 'warn'}">${x.id} ${esc(x.severity)}</span> &nbsp;${esc(x.label)} <span class="mono" style="font-weight:400;font-size:19px;color:#8b98a5">&nbsp;${esc(x.commit)}</span> &nbsp;<span class="ok mono" style="font-size:20px">${x.status === 'passed' ? 'PASS' : 'FAIL'}</span></div>` +
        `<div class=mono style="font-size:15.5px;line-height:21px;color:#c9d1d9;margin-top:4px">${esc(x.testFile)}: "${esc(x.test)}"</div></div>`
    }).join('')
    return frame('Three fixes from a separate review of the code', 'High and Medium findings, each fixed with a test that failed first and passes now.', rows,
      `docs/SECURITY-REVIEW-W2.md; tests re-run for this video with vitest: ${f.vitest.files} files, ${f.vitest.tests} tests, ${f.vitest.passed} passed`)
  },
  payments: (f) => {
    const p = f.payments
    const L = p.block.map((l, i) => `<div class="${i === 0 || i === p.block.length - 1 ? 'hl' : ''}" style="padding:2px 12px;white-space:pre">${esc(l)}</div>`).join('')
    return frame('Payments to the demo payee, counted from the chain', 'Read with no key by scripts/w2-economics.ts on 2026-11-11.', `<div class=mono style="font-size:19px;line-height:32px">${L}</div>`,
      `${p.source} L${p.first}-L${p.last}`)
  },
  notdone: (f) => frame('Not done', 'Copied from docs/WAVE2.md, the Not done list.', `<div style="font-size:27px;line-height:1.28">${f.notDone.map((n) => `<div style="margin:0 0 8px"><span class=warn>-</span> ${esc(n)}</div>`).join('')}</div>`, 'docs/WAVE2.md, section Not done'),
  end: (f) => html(`<h1 style="font-size:46px">Mezo Agent Toolkit</h1><div class=sub>Wave 2 demo</div>` +
    `<div style="font-size:30px;line-height:1.35;margin:10px 0 26px">${esc(f.status)}</div>` +
    `<div class="mono blue" style="font-size:30px;font-weight:700;margin-bottom:26px;font-variant-ligatures:none">${esc(f.repoUrl)}</div>` +
    `<div style="font-size:24px;color:#c9d1d9">${esc(f.disclosure)}<br>${esc(f.voiceNote)}</div>`),
}

export async function slides(f) {
  mkdirSync(SLIDES, { recursive: true })
  const b = await browser()
  const page = await (await b.newContext({ viewport: { width: W, height: STAGE_H } })).newPage()
  const out = {}
  try {
    for (const s of script(f).segments.filter((x) => SLIDE[x.screen])) {
      const k = key(s)
      const file = join(SLIDES, `${k}.html`)
      writeFileSync(file, SLIDE[s.screen](f, s.variant))
      await page.goto(pathToFileURL(file).href)
      await page.evaluate(() => document.fonts.ready)
      gate(await page.evaluate(() => document.body.innerText), `slide ${k}`)
      const over = await page.evaluate(() => [document.documentElement.scrollHeight > innerHeight + 1, [...document.querySelectorAll('body *')].some((e) => e.getBoundingClientRect().right > innerWidth + 1)])
      if (over[0] || over[1]) throw new Error(`slide ${k} does not fit ${W}x${STAGE_H} (height overflow ${over[0]}, width overflow ${over[1]})`)
      out[k] = join(SLIDES, `${k}.png`)
      await page.screenshot({ path: out[k] })
      rmSync(file) // the html names this machine's font paths; only the png is kept
    }
  } finally { await b.close() }
  return out
}

/** Films one explorer page: the clip starts when the page is loaded and the rows of interest are scrolled into view. */
export async function live(f, seconds = 16) {
  mkdirSync(LIVE, { recursive: true })
  const b = await browser()
  const out = {}
  try {
    for (const [name, tx] of [['claim', f.chain.claim], ['repay', f.chain.repay]]) {
      const ctx = await b.newContext({ viewport: { width: W, height: STAGE_H }, recordVideo: { dir: join(LIVE, name), size: { width: W, height: STAGE_H } }, locale: 'en-US', timezoneId: 'UTC' })
      const t0 = Date.now()
      const page = await ctx.newPage()
      await page.goto(tx.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.getByText('Transaction details').first().waitFor({ timeout: 45000 })
      await page.getByText(tx.hash).first().waitFor({ timeout: 30000 })
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      await page.mouse.wheel(0, 200)
      await page.waitForTimeout(500)
      await page.evaluate((u) => { const d = document.createElement('div'); d.textContent = u; d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#000;color:#fff;font:600 15px/24px monospace;padding:0 10px'; document.body.append(d) }, tx.url)
      const ready = (Date.now() - t0) / 1000
      await page.waitForTimeout(seconds * 1000)
      const v = page.video()
      await ctx.close()
      const raw = await v.path()
      const mp4 = join(LIVE, `${name}.mp4`)
      // cut from just after the page was ready (Playwright's video starts when the page is created), re-encode to a clean constant-rate clip
      await run('ffmpeg', ['-y', '-v', 'error', '-nostdin', '-ss', String(Math.max(0, ready - 0.1)), '-i', raw, '-t', String(seconds - 1), '-an', '-vf', `fps=25,scale=${W}:${STAGE_H}`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', mp4])
      out[name] = { file: mp4, ready, seconds: seconds - 1, url: tx.url }
    }
  } finally { await b.close() }
  writeFileSync(join(LIVE, 'live.json'), JSON.stringify(out, null, 2) + '\n')
  return out
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const f = JSON.parse(readFileSync(join(RAW, 'facts.json'), 'utf8'))
  const r = process.argv[2] === 'live' ? await live(f) : await slides(f)
  console.log(`${process.argv[2]}: ${Object.keys(r).join(', ')}`)
}
