// The console page served at `/` by the Worker: one self-contained HTML document, a tight Content-Security-Policy and no external resources.
// Everything except the list of recent payments is rendered here from the Worker's own settings; the list is filled in by a tiny script
// that reads the free JSON route /api/payments. The CSP allows exactly that one inline script and that one inline style, by their SHA-256 hashes.
import type { Address } from 'viem'
import { addressUrl, EXPLORER } from './config.ts'

export interface ConsoleInfo {
  /** Public origin of this Worker as the browser sees it, for example https://example.workers.dev (from the request URL). */
  origin: string
  network: string
  chainId: number
  /** Price of one call in MUSD, derived from the same price string that builds the 402 challenge. */
  priceMusd: string
  payee: Address
  lens: Address
  facilitatorHost: string
  /** "METHOD /path" -> what it returns; the paid routes. */
  endpoints: Record<string, string>
}

/** The paid routes as /status lists them. src/app.ts is the source of these texts; a test compares the two so they cannot drift apart. The page does not ask the facilitator-dependent app for them, so it loads even when the facilitator is down. */
export const PAID_ROUTES: Record<string, string> = {
  'GET /v1/trove/:address': 'Health of one MUSD trove: collateral ratio, debt, liquidation price',
  'GET /v1/redemption/:address': 'Where one trove stands in the MUSD redemption queue, with system context',
  'GET /v1/pool/quote': 'Quote a swap on the Mezo DEX: output, reserves and price impact',
  'GET /v1/ve/:address': 'veBTC and veMEZO locks held by one address',
}

/** Any valid address works for the demo challenge: the 402 does not depend on whether the address holds a trove. */
const SAMPLE_ADDRESS = '0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#14181f;--muted:#465162;--link:#0b5cad;--code:#f1f4f8;--line:#b9c3d0;--warn-bg:#fff0c2;--warn-fg:#4d3600;--focus:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--fg:#e6ebf2;--muted:#a9b4c3;--link:#8ec5ff;--code:#18202a;--line:#3a4656;--warn-bg:#4a3a00;--warn-fg:#ffe9a6;--focus:#8ec5ff}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 .5rem}
h2{font-size:1.25rem;line-height:1.3;margin:2rem 0 .5rem}
p{margin:.5rem 0}
a{color:var(--link)}
a:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:2px}
.touch{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:0 .25rem}
.skip{position:absolute;left:-999px;top:0;background:var(--bg);padding:.75rem 1rem;z-index:2}
.skip:focus{left:.5rem;top:.5rem}
.badge{display:inline-block;background:var(--warn-bg);color:var(--warn-fg);font-weight:600;border-radius:.25rem;padding:.25rem .6rem}
.muted{color:var(--muted)}
dl{margin:0;display:grid;grid-template-columns:minmax(0,11rem) minmax(0,1fr);gap:.5rem 1rem}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
@media (max-width:30rem){dl{grid-template-columns:minmax(0,1fr);gap:0}dd{margin-bottom:.75rem}.addr{font-size:.75rem}}
code,pre{font:.875rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);border-radius:.2rem;padding:.05rem .25rem}
pre{background:var(--code);border:1px solid var(--line);border-radius:.4rem;padding:.75rem;margin:.5rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{background:none;padding:0}
ul.routes{margin:.5rem 0;padding-left:1.25rem}
ul.routes li{margin:.25rem 0;overflow-wrap:anywhere}
ol.payments{list-style:none;margin:.5rem 0;padding:0}
ol.payments li{border:1px solid var(--line);border-radius:.4rem;padding:.5rem .75rem;margin:.5rem 0;overflow-wrap:anywhere}
footer{margin-top:2.5rem;border-top:1px solid var(--line);padding-top:1rem}
`.trim()

// The script reads everything from /api/payments and writes it with textContent, never as HTML.
const JS = `
(function () {
  var list = document.getElementById('payments');
  var note = document.getElementById('payments-note');
  var base = list.getAttribute('data-explorer');
  var short = function (h) { return h.slice(0, 10) + '\\u2026' + h.slice(-6); };
  fetch('/api/payments', { headers: { accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      var n = d.payments.length;
      note.textContent = n === 0
        ? 'No payments found in blocks ' + d.searchedFrom + ' to ' + d.head + '.'
        : n + ' newest of the payments found in blocks ' + d.searchedFrom + ' to ' + d.head + '.';
      d.payments.forEach(function (p) {
        var li = document.createElement('li');
        var amount = document.createElement('strong');
        amount.textContent = p.musd + ' MUSD';
        var when = document.createElement('time');
        when.setAttribute('datetime', p.time);
        when.textContent = ' ' + p.time.replace('T', ' ').slice(0, 19) + ' UTC';
        var from = document.createElement('div');
        from.textContent = 'from ' + short(p.from) + ', block ' + p.block;
        li.append(amount, when, from);
        if (typeof p.explorer === 'string' && p.explorer.indexOf(base) === 0) {
          var a = document.createElement('a');
          a.className = 'touch';
          a.href = p.explorer;
          a.textContent = 'Transaction ' + short(p.transaction);
          li.append(a);
        }
        list.append(li);
      });
    })
    .catch(function () { note.textContent = 'The chain could not be read just now. Reload in a minute.'; });
})();
`.trim()

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`
}

let hashes: Promise<{ style: string; script: string }> | undefined
const assetHashes = () => (hashes ??= Promise.all([sha256(CSS), sha256(JS)]).then(([style, script]) => ({ style, script })))

/** The Content-Security-Policy of the page: nothing is allowed except its own inline style and script (by hash) and requests to its own origin. */
export async function consoleCsp(): Promise<string> {
  const h = await assetHashes()
  return `default-src 'none'; script-src ${h.script}; style-src ${h.style}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}

export function consoleHtml(i: ConsoleInfo): string {
  const url = new URL(i.origin)
  const curl = `curl -si ${i.origin}/v1/trove/${SAMPLE_ADDRESS} | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\\r' | base64 -d`
  const mcp = JSON.stringify(
    {
      mcpServers: {
        mezo: {
          command: 'node',
          args: ['--import', 'tsx', 'src/mcp.ts'],
          cwd: '/path/to/mezo-toolkit',
          env: {
            MEZO_KEY_FILE: '/path/to/funded-testnet.key',
            MEZO_MAX_PER_CALL_MUSD: '0.01',
            MEZO_MAX_PER_SESSION_MUSD: '0.1',
            MEZO_PAY_ALLOWED_HOSTS: url.host,
          },
        },
      },
    },
    null,
    2,
  )
  const routes = Object.entries(i.endpoints)
    .map(([route, what]) => `<li><code>${esc(route)}</code> ${esc(what)}</li>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mezo Agent Toolkit: live testnet console</title>
<meta name="description" content="Read Mezo and pay for it in MUSD with no BTC for gas: a lens contract, an MCP server and an x402 pay-per-call endpoint, running on Mezo testnet.">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<div class="wrap">
<header>
<h1>Mezo Agent Toolkit</h1>
<p><span class="badge">Testnet only: Mezo testnet, chain ${i.chainId}</span></p>
</header>
<main id="main">
<section aria-labelledby="what">
<h2 id="what">What it is</h2>
<p>An AI agent can read Mezo and pay for those reads in MUSD, with no BTC for gas. This page is the live demo: a pay-per-call endpoint (x402) in front of the MezoLens contract, which answers how healthy a MUSD trove is, where it stands in the redemption queue, what a swap on the Mezo DEX would return, and which veBTC and veMEZO locks a wallet holds. It runs on Mezo testnet only, with test money. Nothing here touches Mezo mainnet.</p>
</section>
<section aria-labelledby="status">
<h2 id="status">Status</h2>
<p class="muted">Read from this Worker's settings.</p>
<dl>
<dt>Network</dt><dd>Mezo testnet (${esc(i.network)})</dd>
<dt>Price per call</dt><dd>${esc(i.priceMusd)} MUSD</dd>
<dt>Payee</dt><dd><code class="addr">${esc(i.payee)}</code><br><a class="touch" href="${esc(addressUrl(i.payee))}">Payee on the explorer</a></dd>
<dt>Lens contract</dt><dd><code class="addr">${esc(i.lens)}</code><br><a class="touch" href="${esc(addressUrl(i.lens))}">Lens on the explorer</a></dd>
<dt>Facilitator</dt><dd>${esc(i.facilitatorHost)}, a third party that sends the settlement transaction and pays the BTC gas</dd>
<dt>Paid routes</dt><dd><ul class="routes">
${routes}
</ul></dd>
</dl>
</section>
<section aria-labelledby="try">
<h2 id="try">Try it</h2>
<p>An unpaid request gets HTTP 402 and a payment challenge. This prints it:</p>
<pre><code>${esc(curl)}</code></pre>
<p>To pay for a call, run the toolkit's MCP server on your machine and add it to your agent host. It pays this endpoint in MUSD under spend limits that only you set, and it may call only the hosts you list:</p>
<pre><code>${esc(mcp)}</code></pre>
</section>
<section aria-labelledby="recent">
<h2 id="recent">Recent payments</h2>
<p>MUSD transfers to the payee, newest first, read from the chain. They include the toolkit's own test runs. A transfer shows that a payment landed, not that data was delivered.</p>
<p id="payments-note" class="muted" role="status">Reading the chain...</p>
<ol id="payments" class="payments" data-explorer="${esc(EXPLORER)}/tx/"></ol>
<noscript><p>This list needs JavaScript. The same data is here: <a class="touch" href="/api/payments">/api/payments</a></p></noscript>
</section>
</main>
<footer>
<p class="muted">MIT licence. Testnet only.</p>
<p class="muted">Data as JSON: <a class="touch" href="/status">/status</a> <a class="touch" href="/api/payments">/api/payments</a></p>
</footer>
</div>
<script>${JS}</script>
</body>
</html>
`
}

export async function consoleResponse(i: ConsoleInfo): Promise<Response> {
  return new Response(consoleHtml(i), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': await consoleCsp(),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    },
  })
}
