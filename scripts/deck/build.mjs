// Builds docs/deck.pdf from docs/deck.html with headless Chromium, offline, and checks the result. From any folder:
//   env -u DISPLAY TZ=UTC node scripts/deck/build.mjs
// TZ=UTC keeps a local offset out of the PDF's CreationDate. Every request that is not file:// is aborted and counted; one is a failure.
// playwright-core is not a dependency of the toolkit: set PLAYWRIGHT_CORE to its folder (else the copy under ~/.local/share/claude-playwright-mcp, else a normal import).
// CHROMIUM overrides the browser binary (default /usr/bin/chromium). DECK_FACTS overrides evidence/take-facts.json.
// The facts file feeds three blocks of docs/deck.html (between <!--facts:NAME--> markers): the test count and the new transactions (slide 8) and the lens walk (slide 6).
// Without it the test count comes from the README and no run is shown. Only those blocks are rewritten, so the same inputs always give the same HTML.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HTML = join(ROOT, 'docs', 'deck.html')
const PDF = join(ROOT, 'docs', 'deck.pdf')
const FACTS = process.env.DECK_FACTS ?? join(ROOT, 'evidence', 'take-facts.json')
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium'
const EXPLORER_TX = 'https://explorer.test.mezo.org/tx/'
const LINKS = ['https://github.com/Kylne700', 'https://github.com/Kylne700/mezo-agent-toolkit', 'https://mezo-agent-toolkit.kylne700.workers.dev']
const SLIDES = 11
const FONT_FILES = ['Inter-Regular.otf', 'Inter-SemiBold.otf', 'Inter-Bold.otf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf', 'OFL-Inter.txt', 'OFL-JetBrainsMono.txt']

let failed = 0
const check = (ok, what) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}
const stop = (msg, code = 1) => {
  console.error(msg)
  process.exit(code)
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const short = (h) => `${h.slice(0, 10)}...${h.slice(-6)}`
const link = (h) => `<a href="${EXPLORER_TX}${h}">${short(h)}</a>`

// 1. Inputs: the README gives the default test count, the facts file (if any) the rest.
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const readmeTests = readme.match(/(\d+) tests in (\d+) files/)
if (!readmeTests) stop('README.md has no "N tests in M files"')

function loadFacts() {
  if (!existsSync(FACTS)) return null
  let f
  try {
    f = JSON.parse(readFileSync(FACTS, 'utf8'))
  } catch (e) {
    stop(`facts file is not valid JSON: ${e.message}`)
  }
  const int = (v) => Number.isInteger(v) && v >= 0
  const bad = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? '')) bad.push('date')
  if (f.explorerTx !== undefined && f.explorerTx !== EXPLORER_TX) bad.push('explorerTx')
  if (f.tests !== undefined && !(int(f.tests?.passed) && int(f.tests?.files))) bad.push('tests')
  if (f.lens !== undefined && !(int(f.lens?.stepsWalked) && int(f.lens?.listSize))) bad.push('lens')
  // Slide 8 has room for three new rows next to the four older ones (four overflow into the footer).
  if (f.txs !== undefined && !(Array.isArray(f.txs) && f.txs.length <= 3 && f.txs.every((t) => typeof t.label === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.hash) && int(t.block)))) bad.push('txs')
  if (bad.length) stop(`facts file has wrong or missing fields: ${bad.join(', ')}`)
  return f
}
const facts = loadFacts()
console.log(`facts file: ${facts ? 'found' : 'missing'}`)

// 2. Rewrite the generated blocks of deck.html.
const rows = (facts?.txs ?? []).map((t) => `        <tr><td>${esc(t.label)}<span class="muted"> - block ${t.block}</span></td><td class="mono">${link(t.hash)}</td></tr>`).join('\n')
const blocks = {
  tests: facts?.tests
    ? `<span class="big accent">${facts.tests.passed}</span><span class="big-t">tests passed in ${facts.tests.files} files</span>`
    : `<span class="big accent">${readmeTests[1]}</span><span class="big-t">tests in ${readmeTests[2]} files</span>`,
  txs: facts?.txs?.length ? `\n      <p class="label">Testnet runs, ${facts.date}</p>\n      <table class="tx">\n${rows}\n      </table>\n      ` : '',
  lens: facts?.lens ? `\n  <div class="callout">Testnet run, ${facts.date}: redemptionQueue walked <b class="mono">${facts.lens.stepsWalked}</b> of ${facts.lens.listSize} list nodes.</div>\n  ` : '',
}
const before = readFileSync(HTML, 'utf8')
let html = before
for (const [name, inner] of Object.entries(blocks)) {
  const re = new RegExp(`(<!--facts:${name}-->)[\\s\\S]*?(<!--/facts:${name}-->)`)
  if (!re.test(html)) stop(`docs/deck.html has no facts:${name} markers`)
  html = html.replace(re, (_, open, close) => open + inner + close)
}
if (html !== before) writeFileSync(HTML, html)
console.log(`blocks: tests from ${facts?.tests ? 'facts' : 'README'}, ${facts?.txs?.length ?? 0} new transactions, lens run ${facts?.lens ? 'shown' : 'not shown'}`)

// 3. Checks on the source: no script, nothing external, every hash and address traceable.
const xmlns = 'xmlns="http://www.w3.org/2000/svg"'
const urls = html.replaceAll(xmlns, '').match(/https?:\/\/[^\s"'<>)]+/g) ?? []
const foreign = urls.filter((u) => !u.startsWith(EXPLORER_TX) && !LINKS.includes(u))
const cssUrls = [...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/['"]/g, '')).filter((u) => !u.startsWith('#')) // #id references are the SVG arrowheads
const known = new Set([...(readme.match(/0x[0-9a-fA-F]{64}/g) ?? []), ...(facts?.txs ?? []).map((t) => t.hash)].map((h) => h.toLowerCase()))
const txLinks = [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].filter((m) => m[1].startsWith(EXPLORER_TX))
const txGood = txLinks.filter((m) => {
  const h = m[1].slice(EXPLORER_TX.length)
  return /^0x[0-9a-fA-F]{64}$/.test(h) && known.has(h.toLowerCase()) && m[2] === short(h)
})
const addresses = html.match(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []
const readmeLower = readme.toLowerCase()
check(/<title>Mezo Agent Toolkit - pitch deck<\/title>/.test(html), 'title is "Mezo Agent Toolkit - pitch deck"')
check((html.match(/<section class="slide"/g) ?? []).length === SLIDES, `${SLIDES} slide sections in the source`)
check(!/<script|<link\b|<img\b|<iframe|<object|<embed|@import|\bsrcset=|\bsrc=/i.test(html), 'source has 0 script, link, img, iframe, object, embed or import')
check(foreign.length === 0 && cssUrls.length === 5 && cssUrls.every((u) => /^fonts\/[A-Za-z-]+\.(otf|ttf)$/.test(u)), `external URLs: ${foreign.length} (only links to the explorer, to GitHub and to the live Worker); font URLs: ${cssUrls.length}, all relative`)
check(FONT_FILES.every((f) => existsSync(join(ROOT, 'docs', 'fonts', f))), `docs/fonts holds ${FONT_FILES.length} files (5 fonts, 2 licence texts)`)
check(txLinks.length > 0 && txGood.length === txLinks.length && txLinks.length <= 4 + (facts?.txs?.length ?? 0) && (html.match(/0x[0-9a-fA-F]{64}/g) ?? []).length === txLinks.length, `${txGood.length} of ${txLinks.length} transaction links have a full hash from README.md or the facts file, shown as first 10 + ... + last 6`)
check(addresses.every((a) => readmeLower.includes(a.toLowerCase())), `${addresses.length} addresses printed, ${addresses.filter((a) => !readmeLower.includes(a.toLowerCase())).length} missing from README.md`)

// 4. Render in headless Chromium, print media, offline.
async function loadPlaywright() {
  for (const dir of [process.env.PLAYWRIGHT_CORE, join(homedir(), '.local/share/claude-playwright-mcp/node_modules/playwright-core')]) {
    if (dir && existsSync(join(dir, 'index.mjs'))) return import(pathToFileURL(join(dir, 'index.mjs')).href)
  }
  try {
    return await import('playwright-core')
  } catch {
    return stop('playwright-core not found: set PLAYWRIGHT_CORE to its folder', 2)
  }
}
const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
let pdf
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let fileRequests = 0
  const otherRequests = []
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith('file://')) {
      fileRequests++
      return route.continue()
    }
    otherRequests.push(url.slice(0, 60))
    return route.abort()
  })
  await page.emulateMedia({ media: 'print' })
  await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)

  const info = await page.evaluate((total) => {
    const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/['"]/g, ''), status: f.status }))
    const slides = [...document.querySelectorAll('section.slide')].map((s, i) => {
      const box = s.getBoundingClientRect()
      const foot = s.querySelector('.foot')
      let bottom = 0
      for (const e of s.querySelectorAll('*')) {
        if (e.closest('.foot')) continue
        const r = e.getBoundingClientRect()
        if (r.width > 0 || r.height > 0) bottom = Math.max(bottom, r.bottom - box.top)
      }
      let minFont = Infinity
      let words = 0
      const walk = document.createTreeWalker(s, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent.trim()
        if (!t) continue
        minFont = Math.min(minFont, parseFloat(getComputedStyle(n.parentElement).fontSize))
        if (!n.parentElement.closest('.foot')) words += t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
      }
      return {
        w: box.width,
        h: box.height,
        overflow: s.scrollHeight > s.clientHeight || s.scrollWidth > s.clientWidth,
        gap: Math.round(foot.getBoundingClientRect().top - box.top - bottom),
        minFont,
        words,
        number: foot.lastElementChild.textContent === `${i + 1} / ${total}` && foot.firstElementChild.textContent === 'Mezo Agent Toolkit - Wave 1 - testnet',
      }
    })
    return { faces, slides }
  }, SLIDES)

  const s = info.slides
  const count = (family) => info.faces.filter((f) => f.family === family && f.status === 'loaded').length
  check(s.length === SLIDES && s.every((x) => x.w === 1280 && x.h === 720), `${s.filter((x) => x.w === 1280 && x.h === 720).length} of ${s.length} slides measure exactly 1280x720`)
  check(s.every((x) => !x.overflow), `${s.filter((x) => x.overflow).length} slides have scrollHeight > clientHeight or scrollWidth > clientWidth`)
  check(s.every((x) => x.gap >= 8), `content ends above the footer on ${s.filter((x) => x.gap >= 8).length} of ${s.length} slides (smallest gap ${Math.min(...s.map((x) => x.gap))} px)`)
  check(s.every((x) => x.minFont >= 18), `smallest text on any slide: ${Math.min(...s.map((x) => x.minFont))} px (limit 18)`)
  check(s.every((x) => x.number), `footer text and "n / ${SLIDES}" correct on ${s.filter((x) => x.number).length} of ${s.length} slides`)
  check(info.faces.length === 5 && count('Inter') === 3 && count('JetBrains Mono') === 2, `document.fonts: Inter ${count('Inter')} of 3 loaded, JetBrains Mono ${count('JetBrains Mono')} of 2 loaded (${info.faces.length} faces declared)`)
  const top = s.reduce((a, x, i) => (x.words > s[a].words ? i : a), 0)
  console.log(`INFO  words per slide: ${s.map((x) => x.words).join(' ')} (most: slide ${top + 1} with ${s[top].words}; guide is about 60)`)

  pdf = await page.pdf({ width: '1280px', height: '720px', printBackground: true, preferCSSPageSize: true })
  check(otherRequests.length === 0, `requests that were not file:// : ${otherRequests.length} (aborted by page.route), file:// requests seen: ${fileRequests}`)
} finally {
  await browser.close()
}

// 5. Checks on the PDF itself.
writeFileSync(PDF, pdf)
const text = pdf.toString('latin1')
const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length
const fonts = [...new Set([...text.matchAll(/\/(?:BaseFont|FontName)\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map((m) => m[1]))].sort()
const created = text.match(/\/CreationDate\s*\(D:\d{14}([^)]*)\)/)
check(pages === SLIDES, `${relative(ROOT, PDF)} has ${pages} pages (expected ${SLIDES}, 16:9)`)
check(fonts.length === 5 && fonts.every((n) => /^(Inter|JetBrainsMono)-/.test(n)), `${fonts.length} fonts named in the PDF, all Inter or JetBrainsMono: ${fonts.join(', ')}`)
check(/\/Title\s*[(<]/.test(text) && !/\/Author\b/.test(text), 'PDF has a title and no author')
check(created !== null && /^(Z|\+00'?(00'?)?)?$/.test(created[1]), `PDF CreationDate offset is UTC${created ? '' : ' (no CreationDate found)'}`)
const homeHits = text.split(['', 'home', ''].join('/')).length - 1 // the pattern is built here, so this file holds no home path itself
check(homeHits === 0, `home directory paths in the PDF: ${homeHits}`)

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
