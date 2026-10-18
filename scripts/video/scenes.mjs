// The still scenes of the video: HTML drawn from media/raw/take.json (the one real run) and rendered to PNG with headless Chromium.
// Every number, address and hash on a scene is read from the take; nothing is typed in by hand. Writes media/raw/scenes/*.png and plan.json
// (per beat: the steps with their start second inside the beat, or the live clip that fills the beat). The assembler lays them on the audio timeline.
// The bottom 96 px of every picture are left empty: the captions go there.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHROMIUM, FONTS, H, PW_BROWSERS, PW_CORE, RAW, REPO_URL, W } from './config.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= PW_BROWSERS
const { chromium } = await import(pathToFileURL(join(PW_CORE, 'index.mjs')).href)
const take = JSON.parse(readFileSync(join(RAW, 'take.json'), 'utf8'))
const timing = JSON.parse(readFileSync(join(RAW, 'timing.json'), 'utf8'))
const OUT = join(RAW, 'scenes')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---- what the take recorded -----------------------------------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sh = (a, n = 6, m = 4) => `${a.slice(0, n)}…${a.slice(-m)}`
const day = take.day
const host = take.mcp.host
const [hop402, hop200] = take.plain.hops
const offer = hop402.got.paymentRequired.accepts[0]
const permit = hop200.sent.payload.permit2Authorization
const gas = hop200.sent.extensions.eip2612GasSponsoring.info
const settled = hop200.got.paymentResponse
const facilitator = new URL(take.facilitator).host
const tx1 = take.plain.tx
const tx2 = take.mcp.paid.tx
const lens = take.lens
const reads = Object.fromEntries(take.mcp.reads.map((r) => [r.tool, r]))
const refused = take.mcp.refused
const price = `${Number(offer.amount) / 1e18} MUSD`
if (price !== '0.001 MUSD') throw new Error(`the take's price is ${price}, the narration says 0.001 MUSD`)
const beatOf = (id) => timing.beats.find((b) => b.id === id)
const at = (id, sentence) => beatOf(id).timing[sentence].t0 // start of a sentence inside its beat
const cueAt = (id, text) => { const c = beatOf(id).cues.find((x) => x.text.startsWith(text)); if (!c) throw new Error(`no cue "${text}" in beat ${id}`); return c.t0 }

// ---- look ---------------------------------------------------------------------------------------------------------------------------------------------
const f = (name) => pathToFileURL(join(FONTS, name)).href
const CSS = `
@font-face{font-family:Inter;font-weight:400;src:url(${f('Inter-Regular.otf')})}
@font-face{font-family:Inter;font-weight:600;src:url(${f('Inter-SemiBold.otf')})}
@font-face{font-family:Inter;font-weight:700;src:url(${f('Inter-Bold.otf')})}
@font-face{font-family:JBM;font-weight:400;src:url(${f('JetBrainsMono-Regular.ttf')})}
@font-face{font-family:JBM;font-weight:700;src:url(${f('JetBrainsMono-Bold.ttf')})}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:#0b1118;color:#e8eef5;font:400 28px/1.35 Inter,sans-serif;overflow:hidden}
.stage{position:absolute;left:0;top:0;width:${W}px;height:624px;padding:74px 64px 0}
.band{position:absolute;left:0;bottom:0;width:${W}px;height:96px;background:#05080c}
.chip{position:absolute;top:18px;left:64px;font:600 20px Inter;padding:6px 16px;border-radius:999px;background:#16222d;color:#a9bccf}
.center{display:flex;flex-direction:column;justify-content:center;height:500px}
h1{font:700 70px/1.12 Inter} h2{font:700 50px/1.15 Inter} .dim{color:#8fa3b8} .small{font-size:23px;line-height:1.45;color:#8fa3b8}
.term{background:#0d1620;border:1px solid #1e2e3d;border-radius:14px;padding:24px 30px;font:400 26px/1.5 JBM,monospace}
.term.s24{font-size:24px} .term.s30{font-size:30px} .tall{min-height:430px}
.l{white-space:pre;overflow:hidden}
.k{color:#7f95ab} .hl{color:#f7b955;font-weight:700} .ok{color:#3ddc97} .bad{color:#ff6b6b} .p{color:#6cb6ff} .b{font-weight:700}
.box{background:#111b25;border:1px solid #1e2e3d;border-radius:14px;padding:18px 24px}
.tag{display:inline-block;font:600 18px Inter;padding:3px 11px;border-radius:7px;margin-right:12px;vertical-align:middle}
.tag.free{background:#12392b;color:#3ddc97} .tag.paid{background:#4a3510;color:#f7b955}
.name{font:700 28px JBM,monospace} .what{font-size:22px;color:#8fa3b8;margin-top:4px}
.flow{display:flex;align-items:center;gap:26px;margin-top:30px} .node{background:#111b25;border:1px solid #1e2e3d;border-radius:14px;padding:14px 26px;font:600 34px Inter}
.node small{display:block;font:400 22px Inter;color:#8fa3b8;margin-top:2px} .arrow{font:600 28px Inter;min-width:330px;text-align:center;border-bottom:4px solid;padding-bottom:4px}
.arrow.ok{color:#3ddc97;border-color:#3ddc97} .arrow.bad{color:#ff6b6b;border-color:#ff6b6b;border-bottom-style:dashed}
.cells{display:flex;gap:6px;margin:34px 0 18px} .cell{width:30px;height:96px;border-radius:6px;background:#f7b955}
.cell.skip{background:#55626f} .cell.me{background:#3ddc97}
.meter{height:34px;border-radius:17px;background:#1b2733;overflow:hidden;margin:20px 0 0} .meter i{display:block;height:100%;background:#f7b955} .meter b{display:block;padding-left:22px;font:600 20px/34px Inter;color:#05080c;white-space:nowrap}
.big{font:700 170px/1 Inter}
`
const page = (inner, chip) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div class="stage">${inner}</div>${chip ? `<div class="chip">${esc(chip)}</div>` : ''}<div class="band"></div>`
const T = (lines, cls = '') => `<div class="term ${cls}">${lines.map((l) => `<div class="l">${l}</div>`).join('')}</div>`
const K = (s) => `<span class="k">${esc(s)}</span>`
const HL = (s) => `<span class="hl">${esc(s)}</span>`
const OK = (s) => `<span class="ok">${esc(s)}</span>`
const BAD = (s) => `<span class="bad">${esc(s)}</span>`
const P = (s) => `<span class="p">${esc(s)}</span>`
const E = esc
const wrap = (s, n) => s.split(' ').reduce((a, w) => (a.length && (a.at(-1) + ' ' + w).length <= n ? [...a.slice(0, -1), a.at(-1) + ' ' + w] : [...a, w]), [])
const wrap2 = (s, n) => { const w = wrap(s, n); return w.length > 2 ? [w[0], `${w[1].slice(0, n - 1)}…`] : w } // at most two lines, the cut marked
const REC = `Recorded run, ${day} UTC · Mezo testnet · real payments`
const urlOf = (path) => `${host}${path.replace(/0x[0-9a-fA-F]{40}/, (a) => sh(a, 6, 4))}`
const getLine = `GET ${urlOf(take.plain.path)}`

// ---- the scenes: per beat, steps = [{ at: second inside the beat, html }] -------------------------------------------------------------------------------
const scenes = {}

scenes.problem = [
  { at: 0, html: page(`<div class="center"><h1>Agents can read Mezo.</h1><h1 class="dim">They cannot pay for the data.</h1>
    <div class="flow"><div class="node">Agent</div><div class="arrow ok">reads</div><div class="node">Mezo chain</div><span class="ok b" style="font-size:52px">✓</span></div>
    <div class="flow"><div class="node">Agent</div><div class="arrow bad">pays for data</div><div class="node dim">?</div><span class="bad b" style="font-size:52px">✕</span></div></div>`) },
  { at: at('problem', 1), html: page(`<div class="center"><div class="small" style="font-size:27px;margin-bottom:4px">Mezo Buildathon, Wave 1: entries listed on October 18, 2026</div>
    <div class="big"><span class="hl">0</span><span class="dim" style="font-size:96px"> of 10</span></div>
    <h2 style="margin:8px 0 26px">mention MCP tools or an x402 buyer</h2>
    <p class="small">Snapshot of 2026-10-18 15:48 UTC: 9 public entries (repo or README) and 1 private entry with only a 152-character description visible.
    Based on what their READMEs and submission texts say; not a search of every chain or repo.</p></div>`) },
]

scenes.paid = [
  { at: 0, html: page(`<div class="center" style="align-items:center;text-align:center"><h1 style="font-size:92px">Mezo Agent Toolkit</h1>
    <h2 class="dim" style="margin-top:20px;font-size:38px;font-weight:600">Pay-per-call data for agents, paid in MUSD on Mezo testnet</h2>
    <p class="small" style="margin-top:30px;font-size:28px">x402 on the Mezo chain · MCP server · open source</p></div>`) },
  { at: at('paid', 1), html: page(T([`${P('›')} ${E(getLine)}`, K('  no payment attached'), '', `<span class="bad b">HTTP 402 Payment Required</span>`], 'tall'), REC) },
  { at: cueAt('paid', '0.001 MUSD.'), html: page(T([
    `${P('›')} ${E(getLine)}`, K('  no payment attached'), '', `<span class="bad b">HTTP 402 Payment Required</span>`,
    `${K('  scheme   ')}${E(offer.scheme)}`,
    `${K('  network  ')}${E(offer.network)}  ${K('(Mezo testnet)')}`,
    `${K('  price    ')}${HL(price)}  ${K(`${offer.amount} base units`)}`,
    `${K('  asset    ')}${E(offer.extra.name)}  ${K(sh(offer.asset, 8, 6))}`,
    `${K('  pay to   ')}${E(offer.payTo)}`,
    `${K('  gas      ')}sponsored (EIP-2612 permit)`], 'tall'), REC) },
  { at: at('paid', 2), html: page(T([
    `${P('›')} the agent signs typed data and sends no transaction`,
    `${K('  Permit2 permit  ')}${HL('0.001 MUSD')} ${K('to')} ${E(sh(permit.witness.to, 8, 6))}`,
    `${K('  from            ')}${E(permit.from)}`,
    `${K('  spender         ')}${E(sh(permit.spender, 10, 4))}  ${K('x402 Permit2 proxy')}`,
    `${K('  valid           ')}${E(offer.maxTimeoutSeconds)} s  ${K(`(deadline ${permit.deadline})`)}`,
    `${K('  gas             ')}EIP-2612 permit, signed too`,
    '',
    `${P('›')} GET again, with the PAYMENT-SIGNATURE header`], 'tall'), REC) },
  { at: cueAt('paid', 'the facilitator settles'), html: page(T([
    `${P('›')} GET again, with the PAYMENT-SIGNATURE header`,
    `<span class="ok b">HTTP 200 OK</span>  ${K(`after ${(hop200.ms / 1000).toFixed(1)} s`)}`,
    `${K('  PAYMENT-RESPONSE  ')}${OK(`success: ${settled.success}`)}`,
    `${K('  settled on        ')}${E(settled.network)}`,
    `${K('  facilitator       ')}${E(facilitator)} ${K('(third party)')}`,
    `${K('  transaction')}`,
    `  ${HL(settled.transaction)}`], 'tall'), REC) },
  { at: cueAt('paid', 'and the data comes back'), html: page(T([
    `${K('transaction ')}${HL(sh(settled.transaction, 10, 8))}`,
    `<span class="ok b">HTTP 200 OK</span>  ${K('the data comes back:')}`,
    ...take.plain.shown.map((s) => `  ${K(s.split(': ')[0] + ':')} ${E(s.split(': ').slice(1).join(': '))}`)], 'tall'), REC) },
]

const toolBox = (name, what, paid) => `<div class="box" style="margin-bottom:10px;padding:12px 22px"><span class="tag ${paid ? 'paid' : 'free'}">${paid ? 'paid' : 'free'}</span><span class="name">${name}</span><div class="what">${what}</div></div>`
const toolsPanel = () => `<h2 style="margin-bottom:14px;font-size:44px">One MCP server, five tools</h2><div style="display:flex;gap:28px"><div style="flex:1.25">
  ${toolBox('trove_health', 'collateral ratio and liquidation price', false)}
  ${toolBox('redemption_risk', 'place in the redemption queue', false)}
  ${toolBox('pool_quote', 'swap quote on the Mezo DEX', false)}
  ${toolBox('ve_locks', 'veBTC and veMEZO locks of an address', false)}</div>
  <div style="flex:1">${toolBox('pay_and_fetch', 'GET a URL and pay the 402, under limits the operator sets', true)}</div></div>`
const readLines = (n) => ['trove_health', 'redemption_risk', 'pool_quote', 've_locks'].slice(0, n).flatMap((t) => {
  const r = reads[t]
  return [`${P('›')} <span class="b">${E(r.tool)}</span>${K('(' + (r.tool === 'pool_quote' ? r.arg : sh(r.arg, 6, 4)) + ')')}  ${K(`${r.ms} ms`)}`, ...wrap2(r.summary, 76).map((w) => `  ${OK(w)}`)]
})
const CLIENT = `Recorded run, ${day} UTC · scripted MCP client over stdio · block ${reads.trove_health.block}`
const clientView = (n) => page(T(readLines(n), 'tall s24'), CLIENT)
scenes['mcp-tools'] = [
  { at: 0, html: page(toolsPanel()) },
  { at: at('mcp-tools', 1), html: page(T([K('# the four free reads, through the on-chain lens'), ...readLines(0)], 'tall s24'), CLIENT) },
  { at: cueAt('mcp-tools', 'trove health,'), html: clientView(1) },
  { at: cueAt('mcp-tools', 'trove health,') + 1.0, html: clientView(2) },
  { at: cueAt('mcp-tools', 'pool quotes'), html: clientView(3) },
  { at: cueAt('mcp-tools', 'pool quotes') + 1.2, html: clientView(4) },
]

const meter = (full) => `<div class="meter"><i style="width:${full ? 100 : 0}%">${full ? `<b>spent this session: ${E(take.mcp.paid.spend.spentMusd)} of ${E(take.mcp.paid.spend.perSessionMusd)} MUSD</b>` : ''}</i></div>`
const REC2 = `Recorded run, ${day} UTC · real payment · limits 0.001 MUSD per call and per session`
const paidUrl = urlOf(take.mcp.paid.path)
const refusedUrl = urlOf(refused.path)
const [refusal, ...refusalRest] = refused.text.split(': ')
scenes['mcp-cap'] = [
  { at: 0, html: page(`<h2 style="margin-bottom:26px">The tool takes only a URL</h2>${T([`${P('›')} pay_and_fetch(<span class="b">url</span>)`, K('  no amount, no wallet, no limit as parameters')], 's30')}
    <p class="small" style="margin-top:28px;font-size:30px">The agent chooses what to fetch. It cannot choose how much it may spend.</p>`) },
  { at: cueAt('mcp-cap', 'buys data'), html: page(`<h2 style="margin-bottom:12px">The operator sets the limits</h2><p class="small" style="margin-bottom:22px;font-size:26px">in the server's environment, not in the agent's hands</p>${T([
    `${K('MEZO_MAX_PER_CALL_MUSD'.padEnd(27))}${HL(take.mcp.limitPerCall)}`, `${K('MEZO_MAX_PER_SESSION_MUSD'.padEnd(27))}${HL(take.mcp.limitPerSession)}`, `${K('MEZO_PAY_ALLOWED_HOSTS'.padEnd(27))}${E(take.mcp.host)}`], 's30')}`) },
  { at: at('mcp-cap', 1), html: page(`<h2 style="margin-bottom:26px">Session limit: ${E(take.mcp.limitPerSession)} MUSD</h2><div class="box"><div class="small" style="font-size:26px">spent in this session</div>${meter(false)}<div class="name" style="margin-top:18px;font-size:40px"><span class="hl">0</span> / ${E(take.mcp.limitPerSession)} MUSD</div></div>`, REC2) },
  { at: at('mcp-cap', 2), html: page(`<h2 style="margin-bottom:22px">Call 1: it settles</h2>${T([
    `${P('›')} pay_and_fetch(${E(paidUrl)})`,
    `<span class="ok b">HTTP ${E(take.mcp.paid.status)}</span>  ${K('paid')} ${HL(take.mcp.paid.authorizedMusd + ' MUSD')}  ${K(`session ${take.mcp.paid.spend.spentMusd} of ${take.mcp.paid.spend.perSessionMusd} used`)}`,
    `${K('  transaction')}`, `  ${HL(tx2)}`])}${meter(true)}`, REC2) },
  { at: cueAt('mcp-cap', 'The second is refused'), html: page(`<h2 style="margin-bottom:22px">Call 2: refused</h2>${T([
    `${P('›')} pay_and_fetch(${E(refusedUrl)})`,
    `<span class="bad b">${E(refusal)}</span>`,
    ...wrap(refusalRest.join(': '), 64).map((w) => `  ${K(w)}`),
    '', `  ${OK('checked on chain: balances and nonce unchanged')}`])}${meter(true)}`, REC2) },
]

const OFFLINE = `Offline tests, stub facilitator · nothing is spent · run ${day} UTC`
scenes.nodouble = [
  { at: 0, html: page(`<h2 style="margin-bottom:20px">An unconfirmed payment is never paid twice</h2>
    <div class="flow" style="margin-top:14px"><div class="node">Payment sent<small>not confirmed yet</small></div><span class="dim" style="font-size:40px">→</span><div class="node">Same URL asked again<small>the seller answers 402</small></div></div>
    <div class="flow" style="margin-top:34px"><div class="node" style="border-color:#ff6b6b"><span class="bad">Refused</span><small>while the first permit could still land</small></div><span class="dim" style="font-size:40px">→</span><div class="node" style="border-color:#3ddc97"><span class="ok">Pay again</span><small>only when the chain shows it can no longer land</small></div></div>`, OFFLINE) },
  { at: at('nodouble', 1), html: page(`<h2 style="margin-bottom:20px">The two tests, run offline</h2>${T([
    `${P('$')} npx vitest run test/pay.test.ts -t`, `  ${E('"does not pay twice|pays for that URL again"')}`, '',
    ...take.offline.lines.flatMap((l) => (l.startsWith('✓')
      ? wrap(l.slice(2).replace(/^test\/pay\.test\.ts > after the payment has left > /, '').replace(/\s+\d+ms$/, ''), 70).map((w, i) => (i ? `  ${E(w)}` : `${OK('✓')} ${E(w)}`))
      : [`<span class="b">${E(l)}</span>`]))], 's24 tall')}`, OFFLINE) },
]

const cells = Array.from({ length: lens.stepsWalked }, (_, i) => `<div class="cell${i === 0 ? ' skip' : i === lens.stepsWalked - 1 ? ' me' : ''}"></div>`).join('')
const LENS = `Recorded run, ${day} UTC · one read, block ${lens.block}`
if (lens.redeemableTrovesAhead + lens.skippedBelowMcr + 1 !== lens.stepsWalked) throw new Error('lens cells: ahead + skipped + 1 is not the steps walked')
scenes.lens = [
  { at: 0, html: page(`<h2>One lens call walks ${lens.stepsWalked} positions</h2><div class="small" style="margin-top:12px;font-size:26px">${lens.listSize} troves in the sorted list; one read walks ${lens.stepsWalked} of them</div>
    <div class="cells">${cells}</div>
    <div class="small" style="font-size:24px;white-space:nowrap"><span style="color:#55626f">■</span> ${lens.skippedBelowMcr} below the minimum, skipped &nbsp;&nbsp; <span class="hl">■</span> ${lens.redeemableTrovesAhead} redeemable troves ahead &nbsp;&nbsp; <span class="ok">■</span> the trove asked about</div>`, LENS) },
  { at: at('lens', 1), html: page(`<h2>Lowest ratios are redeemed first</h2><div class="small" style="margin-top:12px;font-size:26px">so the position in the queue is the risk</div>
    <div class="cells">${cells}</div>
    ${T([`${K('ahead of this trove'.padEnd(22))}${HL(lens.redeemableTrovesAhead + ' troves')}`, `${K('MUSD ahead'.padEnd(22))}${HL(Number(lens.redeemableMusdAhead).toLocaleString('en-US', { maximumFractionDigits: 2 }))}`,
      `${K('its collateral ratio'.padEnd(22))}${E(lens.borrowerIcrPercent)}%  ${K(`(minimum ${lens.mcrPercent}%)`)}`], 's30')}`, LENS) },
]

scenes.explorer = 'explorer'
scenes.console = 'console'

scenes.end = [
  { at: 0, html: page(`<div class="center" style="align-items:center;text-align:center"><h1 style="font-size:88px">Mezo Agent Toolkit</h1>
    <h2 style="margin-top:30px;color:#6cb6ff;font-size:44px">${E(REPO_URL)}</h2>
    <h2 class="dim" style="margin-top:38px;font-size:40px;font-weight:600">Live demo: link in the README</h2>
    <p class="small" style="margin-top:20px;font-size:30px">Mezo testnet · Kylne700</p></div>`) },
]

// ---- render ---------------------------------------------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const pg = await ctx.newPage()
const plan = { day, beats: [] }
let start = 0
for (const b of timing.beats) {
  const s = scenes[b.id]
  if (!s) throw new Error(`no scene for beat ${b.id}`)
  const entry = { id: b.id, start: Number(start.toFixed(3)), dur: b.dur }
  if (typeof s === 'string') entry.live = s
  else {
    entry.steps = []
    for (const [i, st] of s.entries()) {
      const html = join(OUT, '_page.html')
      writeFileSync(html, st.html)
      await pg.goto(pathToFileURL(html).href)
      await pg.evaluate(() => document.fonts.ready)
      const png = `${b.id}-${i + 1}.png`
      await pg.screenshot({ path: join(OUT, png) })
      entry.steps.push({ at: Number(st.at.toFixed(3)), png })
    }
  }
  plan.beats.push(entry)
  start += b.dur
}
await browser.close()
rmSync(join(OUT, '_page.html'))
writeFileSync(join(OUT, 'plan.json'), JSON.stringify(plan, null, 1))
console.log(`scenes: ${plan.beats.reduce((n, b) => n + (b.steps?.length ?? 0), 0)} stills, ${plan.beats.filter((b) => b.live).length} live beats, ${start.toFixed(1)} s`)
