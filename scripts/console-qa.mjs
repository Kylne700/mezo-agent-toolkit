// Browser checks of the console page (/) against a Worker that already runs, for example `npm run dev`. Headless Chromium, one clean browser context per colour scheme and width.
// It checks that the page's own script runs under its Content-Security-Policy while an injected script does not, that no request leaves the origin, that axe-core finds 0 violations,
// that nothing overflows sideways, that every keyboard stop shows a visible focus ring, and that every link is at least a 44 px target (the link inside <noscript> too).
// It also writes screenshots, for a person to look at: no script judges how the page looks.
// Not part of `npm test`: playwright-core and axe-core are not dependencies of the toolkit. Point to copies installed anywhere else:
//   PLAYWRIGHT_CORE=/some/node_modules/playwright-core AXE_CORE=/some/node_modules/axe-core node scripts/console-qa.mjs [--url http://127.0.0.1:8787] [--shots some-dir] [--save evidence/console-qa.log]
// CHROMIUM overrides the browser binary (default /usr/bin/chromium). Read-only: it only loads the page and /api/payments, nothing is paid.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const BASE = (arg('--url') ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const SHOTS = arg('--shots')
const SAVE = arg('--save')
const { PLAYWRIGHT_CORE, AXE_CORE, CHROMIUM = '/usr/bin/chromium' } = process.env
if (!PLAYWRIGHT_CORE || !AXE_CORE) {
  console.error('set PLAYWRIGHT_CORE and AXE_CORE to the folders of playwright-core and axe-core')
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(join(PLAYWRIGHT_CORE, 'index.mjs')).href)
const axeSource = readFileSync(join(AXE_CORE, 'axe.min.js'), 'utf8')
const versionOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version

const lines = []
let failed = 0
const log = (s = '') => (lines.push(s), console.log(s))
const check = (ok, what) => {
  if (!ok) failed++
  log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

// WCAG contrast of two computed colours such as "rgb(11, 92, 173)".
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number)
const lum = (c) => c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
const contrast = (a, b) => {
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

async function run(browser, scheme, width, height, { shot, injection }) {
  const tag = `${scheme} ${width}px`
  log(`\n== ${tag} (viewport ${width}x${height}) ==`)
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
  const page = await context.newPage()
  const problems = []
  const requests = []
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${m.type()}: ${m.text().slice(0, 160)}`))
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 160)}`))
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).origin === BASE ? '' : new URL(r.url()).origin}${new URL(r.url()).pathname}`))
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => { const t = document.getElementById('payments-note')?.textContent ?? ''; return t !== '' && !t.startsWith('Reading') }, null, { timeout: 90_000 })

  const state = await page.evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
    note: document.getElementById('payments-note').textContent,
    rows: document.querySelectorAll('#payments li').length,
    txLinks: document.querySelectorAll('#payments li a[href]').length,
  }))
  check(state.dark === (scheme === 'dark'), `the browser really renders the ${scheme} scheme (page background ${state.bg}, text ${state.fg})`)
  check(state.rows > 0 && state.txLinks === state.rows, `the page's own script ran under the CSP: ${state.rows} recent payments listed, ${state.txLinks} with an explorer link (note: "${state.note}")`)
  check(requests.every((r) => r.startsWith('GET /')) && requests.length === 2 && requests[0] === 'GET /' && requests[1] === 'GET /api/payments', `only the page and its data are requested, nothing from outside: ${requests.join(', ')}`)
  check(problems.length === 0, `no console error or warning and no uncaught exception${problems.length ? ': ' + problems.join(' | ') : ''}`)

  if (injection) {
    const before = problems.length
    const ran = await page.evaluate(() => {
      window.__injected = false
      const s = document.createElement('script')
      s.textContent = 'window.__injected = true'
      document.head.append(s)
      return window.__injected
    })
    await page.waitForTimeout(200)
    check(ran === false && problems.length > before, `a script injected into the page does not run, and the browser reports the CSP violation (${problems.slice(before).join(' | ').slice(0, 120)})`)
    problems.length = before
  }

  const over = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const outside = [...document.querySelectorAll('body *')]
      .filter((e) => !e.closest('.skip') && e.getBoundingClientRect().width > 0 && (e.getBoundingClientRect().right > width + 0.5 || e.getBoundingClientRect().left < -0.5))
      .slice(0, 4)
      .map((e) => `${e.tagName.toLowerCase()}${e.className ? '.' + e.className : ''} right=${Math.round(e.getBoundingClientRect().right)}`)
    return { scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, width, outside }
  })
  check(over.scroll <= over.width && over.body <= over.width && over.outside.length === 0, `no sideways overflow: page ${over.scroll} px, body ${over.body} px, viewport ${over.width} px${over.outside.length ? ', outside: ' + over.outside.join('; ') : ''}`)

  await page.evaluate(axeSource) // evaluated through the debugger protocol, so the page's CSP does not block it
  const axe = await page.evaluate(async () => {
    const r = await axe.run(document)
    const brief = (list) => list.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))
    return { version: axe.version, violations: brief(r.violations), incomplete: brief(r.incomplete), passes: r.passes.length }
  })
  check(axe.violations.length === 0, `axe-core ${axe.version}: ${axe.violations.length} violations, ${axe.passes} rules passed, ${axe.incomplete.length} need review${axe.violations.length ? ' ' + JSON.stringify(axe.violations) : ''}`)
  if (axe.incomplete.length) log(`      needs review (axe cannot decide): ${JSON.stringify(axe.incomplete)}`)

  // Keyboard: Tab through every focusable element once.
  const total = await page.evaluate(() => {
    document.activeElement?.blur?.()
    window.scrollTo(0, 0)
    return document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]').length
  })
  const stops = []
  for (let i = 0; i < total; i++) {
    await page.keyboard.press('Tab')
    stops.push(
      await page.evaluate(() => {
        const e = document.activeElement
        const s = getComputedStyle(e)
        const r = e.getBoundingClientRect()
        return {
          name: (e.textContent || '').trim().slice(0, 34),
          focusVisible: e.matches(':focus-visible'),
          style: s.outlineStyle,
          ring: parseFloat(s.outlineWidth),
          color: s.outlineColor,
          inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          bg: getComputedStyle(document.body).backgroundColor,
        }
      }),
    )
  }
  const names = new Set(stops.map((s) => s.name))
  check(total > 0 && names.size === total, `the Tab key reaches all ${total} focusable elements once each (${stops.map((s) => s.name).join(' > ')})`)
  const weak = stops.filter((s) => !(s.focusVisible && s.style !== 'none' && s.ring >= 2 && s.inView && contrast(s.color, s.bg) >= 3))
  check(weak.length === 0, `every keyboard stop shows a focus ring of at least 2 px, in view, with at least 3:1 contrast against the page${weak.length ? ': ' + JSON.stringify(weak) : ` (ring ${stops[0].ring} px, contrast ${contrast(stops[0].color, stops[0].bg).toFixed(1)}:1)`}`)
  const small = stops.filter((s) => s.w < 44 || s.h < 44)
  const smallest = stops.reduce((m, s) => Math.min(m, s.w, s.h), Infinity)
  check(small.length === 0, `every focusable element is at least 44 x 44 px (smallest side ${smallest} px)${small.length ? ': ' + small.map((s) => `${s.name} ${s.w}x${s.h}`).join('; ') : ''}`)

  const noscript = await page.evaluate(() => {
    const holder = document.createElement('div')
    holder.innerHTML = document.querySelector('noscript').textContent // with scripts on, the browser keeps its content as text
    document.body.append(holder)
    const r = holder.querySelector('a').getBoundingClientRect()
    holder.remove()
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
  })
  check(noscript.w >= 44 && noscript.h >= 44, `the link inside <noscript> is ${noscript.w} x ${noscript.h} px`)

  if (shot && SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.evaluate(() => (document.activeElement?.blur?.(), window.scrollTo(0, 0)))
    await page.screenshot({ path: join(SHOTS, `console-${scheme}-${width}.png`), fullPage: true })
    await page.keyboard.press('Tab') // the skip link
    await page.keyboard.press('Tab') // the first link, with its ring
    await page.screenshot({ path: join(SHOTS, `console-${scheme}-${width}-focus.png`) })
  }
  await context.close()
}

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
log(`console QA of ${BASE}/ on ${new Date().toISOString().slice(0, 19)}Z: Chromium ${browser.version()}, playwright-core ${versionOf(PLAYWRIGHT_CORE)}, axe-core ${versionOf(AXE_CORE)}`)
try {
  await run(browser, 'light', 1280, 800, { shot: true, injection: true })
  await run(browser, 'dark', 1280, 800, { shot: true })
  await run(browser, 'light', 390, 844, { shot: true })
  await run(browser, 'dark', 390, 844, { shot: true })
  await run(browser, 'light', 320, 640, {})
} finally {
  await browser.close()
}
log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`)
if (SAVE) writeFileSync(SAVE, lines.join('\n') + '\n')
process.exit(failed === 0 ? 0 : 1)
