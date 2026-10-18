# Mezo Agent Toolkit

Let an AI agent read Mezo and pay for those reads in MUSD, with no BTC for gas.

Three parts, all on **Mezo testnet (chain 31611)**:

1. **`MezoLens`**, a read-only contract that answers the questions an agent actually asks about Mezo in one `eth_call` each: how healthy is this MUSD trove, where does it stand in the redemption queue, what does this swap quote and cost in price impact, which veBTC / veMEZO locks does this wallet hold.
2. **A pay-per-call HTTP endpoint** (`npm run serve`) that serves those reads for 0.001 MUSD per call using [x402](https://www.x402.org) through the public Mezo facilitator. The buyer signs a permit; the facilitator sends the transaction and pays the BTC gas. The same app also runs as a **Cloudflare Worker** with a console page (see [Live](#live) and [Deploy your own](#deploy-your-own)).
3. **An MCP server** (`npm run mcp`, stdio) with five tools: `trove_health`, `redemption_risk`, `pool_quote`, `ve_locks` and `pay_and_fetch`. `pay_and_fetch` pays x402 servers in MUSD under **hard spend limits that the operator sets in the server's environment and that no tool call can change**.

Everything below was run for real on testnet. The logs are in [`evidence/`](evidence/).

## Mezo integration: contract, address, call, why

All addresses are Mezo testnet and have code on chain (checked by the smoke test).

| Contract | Address | What the toolkit calls | Why |
|---|---|---|---|
| **MezoLens** (ours, source verified on the explorer, MIT) | [`0xBDfD1C0B544319E25b4b99ee1f355e55230f6130`](https://explorer.test.mezo.org/address/0xBDfD1C0B544319E25b4b99ee1f355e55230f6130) | `troveHealth`, `systemSnapshot`, `redemptionQueue(borrower, cursor, maxSteps)`, `poolQuote`, `veLocks` | One consistent read per question instead of many RPC round trips; the redemption queue is walked on chain, up to 300 nodes per call, in pages with a cursor |
| **MUSD** token | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | The x402 payment asset: the buyer signs an EIP-2612 permit for exactly the price; the settlement transaction emits `Approval` and `Transfer` buyer to payee. `balanceOf` in the gate and session scripts | MUSD is both the unit the reads are priced in and what the agent pays with, and a wallet holding only MUSD can pay |
| **x402 Permit2 proxy** | [`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`](https://explorer.test.mezo.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | Target of every settlement transaction (sent by the facilitator, not by the buyer) | This is how a payment is settled on chain; the toolkit checks it on the explorer for each payment |
| **TroveManager** | [`0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0`](https://explorer.test.mezo.org/address/0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0) | `getTroveStatus`, `getEntireDebtAndColl`, `MCR`, `CCR`, `getTCR`, `getEntireSystemColl`, `getEntireSystemDebt`, `checkRecoveryMode` | Trove ratio, debt, liquidation price, system ratio, recovery mode |
| **SortedTroves** | [`0x722E4D24FD6Ff8b0AC679450F3D91294607268fA`](https://explorer.test.mezo.org/address/0x722E4D24FD6Ff8b0AC679450F3D91294607268fA) | `getLast`, `getPrev`, `getSize`, `contains` | The redemption order: a redemption starts at the tail, so the walk goes from the tail towards the borrower |
| **PriceFeed** | [`0x86bCF0841622a5dAC14A313a15f96A95421b9366`](https://explorer.test.mezo.org/address/0x86bCF0841622a5dAC14A313a15f96A95421b9366) | `fetchPrice` | BTC/USD price for every ratio and liquidation price |
| **Pool router** (Mezo DEX) | [`0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9`](https://explorer.test.mezo.org/address/0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9) | `defaultFactory`, `poolFor`, `getReserves`, `getAmountsOut` | Swap quote and price impact (a probe at 1% of the amount against the full amount) |
| **veBTC** | [`0xB63fcCd03521Cf21907627bd7fA465C129479231`](https://explorer.test.mezo.org/address/0xB63fcCd03521Cf21907627bd7fA465C129479231) | `balanceOf`, `ownerToNFTokenIdList`, `locked`, `balanceOfNFT`, `voted` | Locks of a wallet: amount, unlock time, voting power, whether it has voted |
| **veMEZO** | [`0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b`](https://explorer.test.mezo.org/address/0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b) | `balanceOf`, `ownerToNFTokenIdList`, `locked`, `votingPowerOfNFT`, `voted` | Same, for veMEZO |
| **HintHelpers** | [`0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6`](https://explorer.test.mezo.org/address/0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6) | `getRedemptionHints`, **in the verification scripts only** | An independent answer to "which trove would a redemption hit first", to compare with the lens |

Also used: Mezo's native BTC and MEZO ERC-20 precompiles (`0x7b7C…0000`, `0x7b7C…0001`) as token addresses in pool quotes, the Mezo testnet RPC `https://rpc.test.mezo.org` and the public x402 facilitator `https://facilitator.vativ.io`.

### Transactions

| What | Transaction |
|---|---|
| Lens deployed (block 16229406, 10651 bytes of code) | [`0x4c673819…821dd1`](https://explorer.test.mezo.org/tx/0x4c673819554eaf1fa88131e463253cc8f40a04df01093f799b997ffe56821dd1) |
| BTC to MUSD swap on the Mezo DEX, to fund the buyer (0.0002 BTC for 15.74 MUSD) | [`0xe43a7aaf…c5be`](https://explorer.test.mezo.org/tx/0xe43a7aaf4a997a9b1a0242546874a8812f813e14b8cd293f304310fcd385c5be) |
| **First paid call settled through the facilitator** (the day-one gate) | [`0x1499eccd…7b9d`](https://explorer.test.mezo.org/tx/0x1499eccd92b3932c53de8f0d5510ca9e8efb955c7c1c1c7ea53f9a2bfa6f7b9d) |
| 402 then 200 on all four paid routes ([`evidence/gate-402-then-200.log`](evidence/gate-402-then-200.log)) | [`0xb2063d3a…2aa8`](https://explorer.test.mezo.org/tx/0xb2063d3a1c8c38ea19bdefd537938c528affc2fce3fcf4dc7218eeaa31752aa8), [`0x2697a4f4…6a9c`](https://explorer.test.mezo.org/tx/0x2697a4f4189a5559b19815ebd7f7a7bea5e4e703a4400d703136e7c3929a6a9c), [`0x21e1ec30…81ea`](https://explorer.test.mezo.org/tx/0x21e1ec30d4a3e78abac9ac74ceceef7e89f794da6c4ac4eb6d89d382941881ea), [`0x591aa181…6b18`](https://explorer.test.mezo.org/tx/0x591aa18114ded99f9f574addc25d283d703b6a6eafa36ec87302c8235faf6b18) |
| Two payments made by an AI-agent tool call over MCP ([`evidence/mcp-session.log`](evidence/mcp-session.log)) | [`0x7b35e64c…0fcb`](https://explorer.test.mezo.org/tx/0x7b35e64ca7e324b39f26a0bf302a60ab407313bdf18d03c1b80bb69cfd3d0fcb), [`0xcbca7dd3…3893c`](https://explorer.test.mezo.org/tx/0xcbca7dd38472da280e4d69fb8aa84db70fe1e8b6742b963e692effba3463893c) |
| The same two payments on the code after the payment review ([`evidence/mcp-session-review-1-final.log`](evidence/mcp-session-review-1-final.log)) | [`0xb15e02af…9119`](https://explorer.test.mezo.org/tx/0xb15e02af41c68da22d05e63afeeed84165cfb8f6446224a83504e97ee9cd9119), [`0x1113ccc1…b1c9`](https://explorer.test.mezo.org/tx/0x1113ccc138a4583ef40290af749641ad8fd951a255c740167829ed7df8a6b1c9) |
| Two payments to the Worker running under `wrangler dev`, made by `pay_and_fetch` ([`evidence/worker-smoke-run1.log`](evidence/worker-smoke-run1.log), [`evidence/worker-smoke.log`](evidence/worker-smoke.log)) | [`0xaad142ca…84b1`](https://explorer.test.mezo.org/tx/0xaad142ca68e61a9735dc6bd078bfdc6041922cccaeb2444293068dd2210984b1), [`0x779df435…d4d8`](https://explorer.test.mezo.org/tx/0x779df435a79b4a61486b17ebb300898a2f63590c2188974f9c94a46f4a89d4d8) |

In every settlement the explorer shows the transaction sent by the facilitator to the x402 proxy, one MUSD `Transfer` of exactly 0.001 MUSD from the buyer to the payee, and a buyer BTC balance and nonce that did not change.

## What an agent sees

`trove_health` for the tail of the redemption queue (block 16230202):

> Trove is below the 110% minimum ratio (109.73%) and can be liquidated.

Every answer carries the block it was read at, exact integers under `raw` (big ones as strings), and readable numbers that are cut off, never rounded. `redemption_risk` answers: how many redeemable troves and how much MUSD stand in front of this trove, how many below-minimum troves a redemption skips, which trove would be hit first, and whether the walk finished or hit the step cap.

## Live

The Worker on Cloudflare, Mezo testnet only: **{{LIVE_URL}}**

<!-- Replace every {{LIVE_URL}} in this file with the address `npm run deploy` printed (https://..., no trailing slash), then delete this comment and the next paragraph. -->

Not deployed yet. Until the address above is filled in, `npm run dev` runs the same Worker on your machine, at `http://127.0.0.1:8787`.

* `{{LIVE_URL}}/` is the console page: what this is, the network, the price of one call in MUSD, the payee and the lens with explorer links, a `curl` that prints the live 402 challenge, an MCP configuration for `pay_and_fetch`, and the latest paid calls, read from the chain.
* `{{LIVE_URL}}/v1/trove/<address>` (also `/v1/redemption/<address>`, `/v1/ve/<address>` and `/v1/pool/quote`) is the paid API. Without a payment it answers `402` and the x402 challenge; with one, `200` and the data.
* `{{LIVE_URL}}/status` is the price, the payee and the last settlement that Worker instance saw, as JSON. `{{LIVE_URL}}/api/payments` is the recent payments to the payee, as JSON, read from the chain and kept for 45 seconds.

The same challenge from a terminal:

```
curl -si {{LIVE_URL}}/v1/trove/0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d
```

To let an agent pay it with `pay_and_fetch`, list its host first (step 5 of [Deploy your own](#deploy-your-own)); until then the tool refuses it.

## Run it

Needs Node 22.12 or newer (22, 24 or 26). Reading needs no key and no funds.

```
npm ci
npm test                  # 173 unit and contract tests, offline
npm run smoke             # live, read-only: the lens against direct reads of the protocol, plus the unpaid 402 challenge
npm run serve             # the pay-per-call endpoint on 127.0.0.1:8402 (PORT, HOST, PAYEE_ADDRESS)
npm run dev               # the same endpoint plus the console page, as a Cloudflare Worker on 127.0.0.1:8787, through wrangler dev (no login, no deploy)
npm run mcp               # the MCP server on stdio
```

`PAYEE_ADDRESS` is where payments go; the default is a throwaway testnet address.

### Use the MCP server from an agent host

Add it to the host's MCP configuration with the repository as the working directory (shown as JSON; the exact file depends on the host):

```json
{
  "mcpServers": {
    "mezo": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp.ts"],
      "cwd": "/path/to/mezo-toolkit",
      "env": {
        "MEZO_KEY_FILE": "/path/to/funded-testnet.key",
        "MEZO_MAX_PER_CALL_MUSD": "0.01",
        "MEZO_MAX_PER_SESSION_MUSD": "0.1",
        "MEZO_PAY_ALLOWED_HOSTS": "127.0.0.1"
      }
    }
  }
}
```

The four read tools work with no environment at all. `pay_and_fetch` is **off** unless `MEZO_KEY_FILE` names a file with a funded Mezo testnet key (64 hex characters, the server reads it itself and never prints it). Limits default to 0.01 MUSD per call and 0.1 MUSD per session; a value that does not parse switches payments off instead of falling back. `MEZO_PAY_ALLOWED_HOSTS` is a comma-separated list of the only hosts the tool may call (`host` means any port, `host:port` that port only). Unset or blank, it is `127.0.0.1:8402,localhost:8402`: our own endpoint as `npm run serve` starts it, and nothing else. Add a seller's host to pay it. After you deploy the Worker, its host (host only, no `https://`) goes into the `LIVE_HOSTS` list in `src/mcp-env.ts`, which is empty on purpose until then, or into `MEZO_PAY_ALLOWED_HOSTS`; a test covers both, and the console page's MCP snippet already names the host it is served from.

### Scripts that spend a little testnet MUSD

These need `MEZO_KEY_FILE` pointing at a funded Mezo testnet key (the faucet gives testnet BTC; `scripts/swap.ts` swaps some of it for MUSD).

```
npm run gate              # 402 then 200 on the four paid routes, four payments of 0.001 MUSD
npm run mcp:session       # the real stdio server, every tool, two payments of 0.001 MUSD
npm run worker:smoke      # starts the Worker with wrangler dev, checks it, pays it once (0.001 MUSD) and rewrites evidence/worker-smoke.log; add `-- --no-pay` to pay nothing and write no log (it still reads the key file)
```

## Deploy your own

You need a free Cloudflare account. The Worker holds no secret, only the payee's address. `wrangler` is not a dependency of this repository (it would add LGPL image libraries, which `npm run check:licences` rejects); `npm run dev` and `npm run deploy` run `wrangler@4.151.1` through `npx --yes`, which downloads it on first use.

1. `npm ci`
2. `npx --yes wrangler@4.151.1 login` and sign in to Cloudflare in the browser.
3. Optional: in `wrangler.toml`, set `PAYEE_ADDRESS` to your own testnet address to receive the payments (the default is a throwaway one). `PRICE`, `RPC_URL` and `FACILITATOR_URL` are in the same `[vars]` block.
4. `npm run deploy` publishes the Worker `mezo-agent-toolkit` and prints its address, which looks like `https://mezo-agent-toolkit.<your-subdomain>.workers.dev`. Open it and check that `<address>/status` answers with JSON.
5. Let agents pay it: add the host (host only) to `LIVE_HOSTS` in `src/mcp-env.ts`, or to `MEZO_PAY_ALLOWED_HOSTS` in the MCP server's environment. Then fill in the address in the Live section above (its comment says how).

## How payments and limits work

* The endpoint answers an unpaid GET with `402` and an x402 v2 challenge: scheme `exact`, network `eip155:31611`, asset MUSD, amount 0.001 MUSD, with the EIP-2612 gas-sponsoring extension. Bad input gets `400` before any challenge, so nobody is asked to pay for a request that cannot succeed.
* `pay_and_fetch` makes a plain request first, and only if the server answers `402` does it sign a payment for the quoted amount. The permit it signs is for exactly that amount.
* **Spend guard.** Amounts are checked in MUSD base units (18 decimals) by one synchronous check-and-reserve, before anything is signed. A payment over the per-call limit, or one that would take the session total over the session limit, is refused with a plain reason and nothing is signed. Reaching the session limit exactly is allowed. Payments are serialised. Redirects are not followed. The limits come only from the environment of the server process, never from a tool argument; the tool takes a `url` and nothing else, and its description tells the model the limits.
* A refusal is a tool error that says so. If a payment was sent but the server did not confirm it, the answer says the money may still have been charged and to check the balance before paying again. `pay_and_fetch` then does not pay for that URL again until the chain shows the payment can no longer land: its Permit2 nonce still unused 90 seconds after its deadline, which is at most 300 seconds after signing. If the nonce was used, the payment landed and the seller did not deliver: that URL stays refused for the rest of the session, and the payment is lost (paid but empty). Our own server tries to prevent that case by finding the settlement on chain itself (below).

### A real failure mode, and what the server does about it

Mezo's public RPC sometimes answers `eth_getTransactionReceipt` for a mined transaction with `null` or "method handler crashed". When that happens the facilitator reports `success:false, unexpected_error` and an empty transaction hash, **although the transfer landed**. In testing, between none and all four of the settlements in a run were hit, differing from run to run. Two payments of 0.001 MUSD were lost this way before the fix existed ([`0x51d022f4…12d0f8`](https://explorer.test.mezo.org/tx/0x51d022f4294379ecbf8cb340efe3268ea886bc0d2643ff37076f9cd0b112d0f8) and [`0x4394ca66…062de13`](https://explorer.test.mezo.org/tx/0x4394ca66e457894d648946ea39c1055e817f4c76226d8541b7aafdbce062de13): the buyer paid and got a failure). Two more were lost in the payment review's first two live runs, because the server's own check also read the transaction by hash: [`0x9468a2af…b80d`](https://explorer.test.mezo.org/tx/0x9468a2afdbd589cfd7e63810af25e573e59fb37f29be805e2628d7b3fe6bb80d) (the facilitator reported the receipt error) and [`0x3b69ac81…74ee`](https://explorer.test.mezo.org/tx/0x3b69ac817820b1b7b82d54f1158b297a208d49b0495f4082d7a5df0fdf7474ee) (the facilitator reported success). Read-only probes right after found the RPC answering `null` by hash, for the transaction and its receipt, for every transaction checked (both of run 2's payments among them), in checks minutes apart, while reads by block and index answered at once ([`evidence/rpc-by-hash-probe.log`](evidence/rpc-by-hash-probe.log)).

The paid endpoint asks the chain itself about every settlement, whatever the facilitator reports: it looks for a MUSD `Transfer` from the payer to the payee, of exactly the quoted amount, inside a transaction whose calldata contains **this payment's own signature**, and each transaction can vouch for one payment only. A reported success serves the data only when this finds the payment, so the facilitator's word alone is never enough. A reported failure is overruled when it finds the payment: the call succeeds, and the status page and the logs say the settlement was recovered from the chain. It reads that transaction by block and index, never by hash (above). If the payment is not found after seven looks two seconds apart (about 18 seconds), the buyer gets `402` and no data; if it had landed after all, that buyer has paid and got nothing, there is no refund, and `pay_and_fetch` does not pay for that URL again (above). The mechanism is covered by offline tests (`test/app.test.ts`: the payment is on chain and is this one; no transfer; an earlier payment of the same size; the wrong amount; one transaction vouching twice, also from two recoveries at once; an unreadable chain; a reported success the chain does not show; an RPC whose by-hash lookups answer nothing; a node that shows the transfer only from the fourth look; one search per settlement). Live: the final code's session ([`evidence/mcp-session-review-1-final.log`](evidence/mcp-session-review-1-final.log)) checked both settlements on chain after the facilitator reported success; the two runs before the last fix are kept as [`run1`](evidence/mcp-session-review-1-run1.log) and [`run2`](evidence/mcp-session-review-1-run2.log). Overruling a reported failure has not happened live on the final code; a read-only replay of the final recovery code against the real chain found the `run2` payment in about one second.

## How the numbers were checked

| Check | Result (committed evidence) |
|---|---|
| `npm test` | 173 tests in 10 files: the lens contract against mock Mezo contracts in an in-process EVM (including the paged redemption walk), the spend guard, the buyer against a stub facilitator, the HTTP app, the MCP server over stdio, the Worker (its entry file, its settings, the console page with its security headers, the recent-payments reader and the allowed-host list), and negative tests that plant a fake key, a fake denylist term, a home path, an email and bad licences and expect the three repo checks to fail |
| `npm run smoke` | 23 checks passed ([`evidence/smoke.log`](evidence/smoke.log)). At one pinned block, the lens's trove health (two troves), system snapshot, redemption queue (one call, paged two nodes per call, and stopped by the step cap), three pool quotes (one with 7.05% price impact) and a live veBTC lock equal reads taken straight from TroveManager, SortedTroves, PriceFeed, HintHelpers, the router and veBTC/veMEZO, field by field, and the shown text equals the exact value cut off. Mutating the comparison code made them fail. It also checks that every address in the table above has code on chain and is one the code uses, and that every transaction this README links succeeded on the explorer (11 when the committed log was taken; the README links more now and the script checks whatever it finds) |
| x402 gate | 402 then 200 on all four paid routes, four settlements confirmed ([`evidence/gate-402-then-200.log`](evidence/gate-402-then-200.log)) |
| `npm run mcp:session` | 29 checks passed ([`evidence/mcp-session.log`](evidence/mcp-session.log)): the five tools are listed, `pay_and_fetch` takes only a `url`, every read answer equals direct reads at the block it names, two payments settle (explorer confirms status, block, sender, token transfer), a $0.05 price is refused against a 0.002 MUSD limit, a third payment is refused by the session limit with the facilitator never asked, a host outside the allow list and a bad URL are refused, a free URL is fetched without paying, the buyer's MUSD fell by exactly 0.002 while its BTC balance and nonce did not move, the server process exited, and no answer or log line contained the key, its path or a home path. After the payment review the same 29 checks passed on the final code ([`evidence/mcp-session-review-1-final.log`](evidence/mcp-session-review-1-final.log)) |
| `npm run worker:smoke` | 28 checks passed against the Worker under `wrangler dev` ([`evidence/worker-smoke.log`](evidence/worker-smoke.log); the first paid run, with an earlier console page, also passed 28: [`evidence/worker-smoke-run1.log`](evidence/worker-smoke-run1.log)): the console page (a CSP that allows only its own inline script and style, nothing loaded from outside, the price, payee and lens as `/status` reports them, and the `curl` line on the page prints the same challenge); `/status`; `/api/payments` (10 payments read from the chain, the second call answered from the cache); the 402 challenge (x402 v2, 0.001 MUSD to the payee, gas sponsoring); a bad address gets `400` before any challenge and a malformed payment header gets `402`. Through the MCP server (limits 0.01 per call, 0.1 in total, only `127.0.0.1:8787` allowed) `localhost:8787` is refused and no MUSD moves, then one `pay_and_fetch` pays 0.001 MUSD and returns the trove health that was asked for. The buyer's MUSD fell by exactly 0.001 and the payee's rose by exactly that, the buyer sent no transaction, the explorer confirms the settlement, `/status` and `/api/payments` show it, and nothing the MCP server or the Worker printed contains the key |
| Console page in a browser | 51 checks passed ([`evidence/console-qa.log`](evidence/console-qa.log); `scripts/console-qa.mjs`, headless Chromium, run by hand because playwright-core and axe-core are not dependencies): light and dark at 1280 px and 390 px, and light at 320 px. The page's own script runs under its CSP and an injected script does not; nothing is requested from outside; no console error; no sideways overflow; axe-core 4.14.0 finds 0 violations; Tab reaches every focusable element once with a focus ring of at least 2 px and 3:1 contrast; every link is at least 44 x 44 px. A script cannot judge how the page looks: the screenshots were looked at by hand and are not kept in the repository |
| `npm run check` | no key value anywhere git could publish it (working tree, index and all history), no GPL, LGPL or AGPL package (the one weak-copyleft licence, MPL-2.0, appears only in dev tools), and the privacy denylist, home path and email scan are clean over every committed and evidence file |

## Limits, stated plainly

* **Testnet only.** Nothing here calls Mezo mainnet.
* **The facilitator is a third party** (`facilitator.vativ.io`). If it is down, paid calls fail; the free read tools do not depend on it. Its receipt flake is described above.
* **The MCP read tools are free direct lens reads.** They do not go through x402. The paid path is the HTTP endpoint and `pay_and_fetch`; this keeps reads usable with no wallet, and shows paying in MUSD where an agent needs to buy data from someone else.
* **The session limit belongs to one server process.** A host that restarts the server starts a new session total. The guard never refunds: a payment that was charged but not confirmed still counts as spent.
* **The per-call branch of the guard is proven by unit tests only.** In a live over-price case the x402 client library's own spend control, set to the same limit, refuses first; the log says so.
* **`pay_and_fetch` calls only the hosts on its allow list**, by default just our local endpoint, and it only ever pays MUSD on Mezo testnet. Listing a bare host such as `127.0.0.1` opens every port on it to a plain GET.
* Cancelling an MCP request does not abort a payment that is already in flight. The recovery memory is per process (on the Worker: per instance, see below).
* The readable fields are cut off at a fixed number of places; `raw` is exact.
* **The Worker's memory belongs to one instance.** Which transaction already paid for an answer, and the last settlement that `/status` shows, are kept in the running instance, and Cloudflare decides how many instances run and when one is replaced. Another instance does not know them: a payment sent at the same moment to two instances could be served twice (the answers are public chain data), and `/status` can show a different last settlement or none. This follows from reading the code and was not tested.
* **The Worker needs the facilitator once per instance.** Every route except `/`, `/api/payments` and the favicon asks the facilitator what it supports before it answers (the x402 library does that when the app is built). If the facilitator is down they answer `502` and say so; the console page and the payments list still work.
* **`/api/payments` reads the public RPC.** At most one scan per 45 seconds per instance; if the RPC fails, the last good answer is served and marked stale. A scan goes back at most 114,000 blocks (12 windows of 9,500, because the RPC refuses queries over 10,000 blocks), roughly six days, and the page says which blocks it covered. An older payment is not listed.
* **Cloudflare's limits were not measured.** This build only ran under `wrangler dev`. Cloudflare's documentation (read 2026-10-18) gives the free plan 10 ms of CPU time per request, 50 subrequests per request and 1 s of startup; the Worker's real figures on Cloudflare are unknown. Under Node, a cold paid call used about 2 to 5 ms of CPU, which is only an indication. `wrangler deploy --dry-run` reports a bundle of 2.66 MiB (0.48 MiB compressed).
* The demo payee is a throwaway testnet address. Total paid in x402 payments during development: 0.032 MUSD (the payee holds exactly that): 0.025 in build stage 1, 0.005 in the payment review and 0.002 in the two Worker runs of stage 2.

## Reused code

None copied. The code in this repository was written for it; it depends on the packages in `package.json` (viem, hono, zod, the MCP SDK and the x402 packages, MIT or Apache-2.0).

## Licence

MIT, see [LICENSE](LICENSE). Dependency licences are checked by `npm run check:licences`.
