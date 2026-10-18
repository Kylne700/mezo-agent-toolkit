# Mezo Agent Toolkit

Let an AI agent read Mezo and pay for those reads in MUSD, with no BTC for gas.

Three parts, all on **Mezo testnet (chain 31611)**:

1. **`MezoLens`**, a read-only contract that answers the questions an agent actually asks about Mezo in one `eth_call` each: how healthy is this MUSD trove, where does it stand in the redemption queue, what does this swap quote and cost in price impact, which veBTC / veMEZO locks does this wallet hold.
2. **A pay-per-call HTTP endpoint** (`npm run serve`) that serves those reads for 0.001 MUSD per call using [x402](https://www.x402.org) through the public Mezo facilitator. The buyer signs a permit; the facilitator sends the transaction and pays the BTC gas.
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

In every settlement the explorer shows the transaction sent by the facilitator to the x402 proxy, one MUSD `Transfer` of exactly 0.001 MUSD from the buyer to the payee, and a buyer BTC balance and nonce that did not change.

## What an agent sees

`trove_health` for the tail of the redemption queue (block 16230202):

> Trove is below the 110% minimum ratio (109.73%) and can be liquidated.

Every answer carries the block it was read at, exact integers under `raw` (big ones as strings), and readable numbers that are cut off, never rounded. `redemption_risk` answers: how many redeemable troves and how much MUSD stand in front of this trove, how many below-minimum troves a redemption skips, which trove would be hit first, and whether the walk finished or hit the step cap.

## Run it

Needs Node 22.12 or newer (22, 24 or 26). Reading needs no key and no funds.

```
npm ci
npm test                  # 112 unit and contract tests, offline
npm run smoke             # live, read-only: the lens against direct reads of the protocol, plus the unpaid 402 challenge
npm run serve             # the pay-per-call endpoint on 127.0.0.1:8402 (PORT, HOST, PAYEE_ADDRESS)
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

The four read tools work with no environment at all. `pay_and_fetch` is **off** unless `MEZO_KEY_FILE` names a file with a funded Mezo testnet key (64 hex characters, the server reads it itself and never prints it). Limits default to 0.01 MUSD per call and 0.1 MUSD per session; a value that does not parse switches payments off instead of falling back. `MEZO_PAY_ALLOWED_HOSTS` is an optional comma-separated list of the only hosts the tool may call.

### Scripts that spend a little testnet MUSD

These need `MEZO_KEY_FILE` pointing at a funded Mezo testnet key (the faucet gives testnet BTC; `scripts/swap.ts` swaps some of it for MUSD).

```
npm run gate              # 402 then 200 on the four paid routes, four payments of 0.001 MUSD
npm run mcp:session       # the real stdio server, every tool, two payments of 0.001 MUSD
```

## How payments and limits work

* The endpoint answers an unpaid GET with `402` and an x402 v2 challenge: scheme `exact`, network `eip155:31611`, asset MUSD, amount 0.001 MUSD, with the EIP-2612 gas-sponsoring extension. Bad input gets `400` before any challenge, so nobody is asked to pay for a request that cannot succeed.
* `pay_and_fetch` makes a plain request first, and only if the server answers `402` does it sign a payment for the quoted amount. The permit it signs is for exactly that amount.
* **Spend guard.** Amounts are checked in MUSD base units (18 decimals) by one synchronous check-and-reserve, before anything is signed. A payment over the per-call limit, or one that would take the session total over the session limit, is refused with a plain reason and nothing is signed. Reaching the session limit exactly is allowed. Payments are serialised. Redirects are not followed. The limits come only from the environment of the server process, never from a tool argument; the tool takes a `url` and nothing else, and its description tells the model the limits.
* A refusal is a tool error that says so. If a payment was sent but the server did not confirm it, the answer says the money may still have been charged and to check the balance before paying again.

### A real failure mode, and what the server does about it

Mezo's public RPC sometimes answers `eth_getTransactionReceipt` for a mined transaction with `null` or "method handler crashed". When that happens the facilitator reports `success:false, unexpected_error` and an empty transaction hash, **although the transfer landed**. In testing, between none and all four of the settlements in a run were hit, differing from run to run. Two payments of 0.001 MUSD were lost this way before the fix existed ([`0x51d022f4…12d0f8`](https://explorer.test.mezo.org/tx/0x51d022f4294379ecbf8cb340efe3268ea886bc0d2643ff37076f9cd0b112d0f8) and [`0x4394ca66…062de13`](https://explorer.test.mezo.org/tx/0x4394ca66e457894d648946ea39c1055e817f4c76226d8541b7aafdbce062de13): the buyer paid and got a failure).

The paid endpoint now asks the chain itself after a reported settlement failure: it looks for a MUSD `Transfer` from the payer to the payee, of exactly the quoted amount, inside a transaction whose calldata contains **this payment's own signature**, and each transaction can vouch for one payment only. If found, the call succeeds and the transaction hash is real; the status page and the logs say the settlement was recovered from the chain. If not found, the failure stands. The mechanism is covered by offline tests (`test/app.test.ts`: the payment is on chain and is this one; no transfer; an earlier payment of the same size; the wrong amount; one transaction vouching twice; an unreadable chain). No live run of the final code needed it: the committed gate and session logs show every settlement confirmed by the facilitator.

## How the numbers were checked

| Check | Result (committed evidence) |
|---|---|
| `npm test` | 112 tests in 8 files: the lens contract against mock Mezo contracts in an in-process EVM (including the paged redemption walk), the spend guard, the buyer against a stub facilitator, the HTTP app, the MCP server over stdio, and negative tests that plant a fake key, a fake denylist term, a home path, an email and bad licences and expect the three repo checks to fail |
| `npm run smoke` | 23 checks passed ([`evidence/smoke.log`](evidence/smoke.log)). At one pinned block, the lens's trove health (two troves), system snapshot, redemption queue (one call, paged two nodes per call, and stopped by the step cap), three pool quotes (one with 7.05% price impact) and a live veBTC lock equal reads taken straight from TroveManager, SortedTroves, PriceFeed, HintHelpers, the router and veBTC/veMEZO, field by field, and the shown text equals the exact value cut off. Mutating the comparison code made them fail. It also checks that every address in the table above has code on chain and is one the code uses, and that the 11 transactions linked here succeeded on the explorer |
| x402 gate | 402 then 200 on all four paid routes, four settlements confirmed ([`evidence/gate-402-then-200.log`](evidence/gate-402-then-200.log)) |
| `npm run mcp:session` | 29 checks passed ([`evidence/mcp-session.log`](evidence/mcp-session.log)): the five tools are listed, `pay_and_fetch` takes only a `url`, every read answer equals direct reads at the block it names, two payments settle (explorer confirms status, block, sender, token transfer), a $0.05 price is refused against a 0.002 MUSD limit, a third payment is refused by the session limit with the facilitator never asked, a host outside the allow list and a bad URL are refused, a free URL is fetched without paying, the buyer's MUSD fell by exactly 0.002 while its BTC balance and nonce did not move, the server process exited, and no answer or log line contained the key, its path or a home path |
| `npm run check` | no key value anywhere git could publish it (working tree, index and all history), no GPL, LGPL or AGPL package (the one weak-copyleft licence, MPL-2.0, appears only in dev tools), and the privacy denylist, home path and email scan are clean over every committed and evidence file |

## Limits, stated plainly

* **Testnet only.** Nothing here calls Mezo mainnet.
* **The facilitator is a third party** (`facilitator.vativ.io`). If it is down, paid calls fail; the free read tools do not depend on it. Its receipt flake is described above.
* **The MCP read tools are free direct lens reads.** They do not go through x402. The paid path is the HTTP endpoint and `pay_and_fetch`; this keeps reads usable with no wallet, and shows paying in MUSD where an agent needs to buy data from someone else.
* **The session limit belongs to one server process.** A host that restarts the server starts a new session total. The guard never refunds: a payment that was charged but not confirmed still counts as spent.
* **The per-call branch of the guard is proven by unit tests only.** In a live over-price case the x402 client library's own spend control, set to the same limit, refuses first; the log says so.
* **`pay_and_fetch` is a general GET.** Without `MEZO_PAY_ALLOWED_HOSTS` it will call any http or https host, local ones included, and it only ever pays MUSD on Mezo testnet. Set the allow list.
* Cancelling an MCP request does not abort a payment that is already in flight. The recovery memory is per process.
* The readable fields are cut off at a fixed number of places; `raw` is exact.
* The demo payee is a throwaway testnet address. Total paid in x402 payments during development: 0.025 MUSD (the payee holds exactly that).

## Reused code

None copied. The code in this repository was written for it; it depends on the packages in `package.json` (viem, hono, zod, the MCP SDK and the x402 packages, MIT or Apache-2.0).

## Licence

MIT, see [LICENSE](LICENSE). Dependency licences are checked by `npm run check:licences`.
