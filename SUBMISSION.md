# Submission text: Mezo Agent Toolkit

Mezo Buildathon Wave 1 on Akindo. Paste each fenced text as it is. The counts are for the text with the placeholder as written (`{{VIDEO_URL}}`); replace it with the real link first. Upload the video as Unlisted. After any edit of a field, run `node scripts/check-submission.mjs --fix`: it recounts the characters, rewrites the counts in the headings and checks the limits, also with the placeholder replaced by a link of 100 characters.

Before pasting:

- Only `{{VIDEO_URL}}` is left to fill in (sections 13 and 14). The repository and deck links work once the repository is public and `docs/deck.pdf` is on the main branch.
- If the video is taken again with new payments, replace the two transaction hashes in sections 14 and 16 (they are in `evidence/video-take-<date>.log`), and the date and the log file name where sections 13 and 16 mention the recorded run.
- The sentence about reused code (section 14) matches the README section "Reused code": the Sealdrop video scripts in `scripts/video` (`lib.mjs` and `listen.py` are copied; `config.mjs`, `tts.mjs`, `narration.mjs` and `asr-compare.mjs` are adapted; the file headers say so). A line-overlap check of src, test and the other scripts against Sealdrop and the author's other local projects found only imports and one-line idioms.

## 1. Project name (18 characters)

```text
Mezo Agent Toolkit
```

## 2. Category (25 characters; 3-5 words)

```text
Agent access and payments
```

## 3. TL;DR (138 characters; one sentence)

```text
An AI agent can read Mezo through one MCP server and pay for data in MUSD, with no BTC for gas, under spend limits that the operator sets.
```

## 4. How it works (1,264 characters)

```text
Problem. Agents can read Mezo, but they cannot pay for the data. One question, such as how healthy a trove is and where it stands in the redemption queue, takes many RPC calls and knowledge of several contracts. An agent that must buy data from someone else also needs a wallet, BTC for gas and a limit on what it may spend.
What it does. MezoLens, a read-only contract on Mezo testnet, answers each question in one eth_call. A pay-per-call HTTP endpoint serves the same reads for 0.001 MUSD per call with x402. An unpaid request gets a 402 and the price. The agent signs a permit, the facilitator settles it on Mezo, and the data comes back. An MCP server gives an agent five tools. Four are free reads. The fifth, pay_and_fetch, buys data from x402 servers under limits that the operator sets in the server's environment and that no tool call can change.

MUSD. MUSD is the unit the reads are priced in and the asset the agent pays with. The agent pays no gas, because the facilitator sends the transaction and pays the BTC gas. Each settlement shows on the Mezo testnet explorer as one MUSD Transfer of 0.001 from the agent to the payee. The toolkit adds no token and no protocol. It extends what Mezo already has: its contracts, MUSD and the x402 payment flow.
```

## 5. Target group (291 characters)

```text
Developers who build AI agents and agent hosts (any MCP client) and want Mezo data and MUSD payments as tools. Operators who want hard spending limits on an agent that holds a wallet. Mezo developers who want one-call reads of troves, the redemption queue, pool quotes and vote-escrow locks.
```

## 6. Tech stack (347 characters)

```text
TypeScript on Node 22.12 or newer (22, 24 or 26). Solidity 0.8 for MezoLens (compiled with solc 0.8.36). viem, Hono and zod. The MCP SDK over stdio. The x402 v2 packages at 2.28.0 (core, evm, extensions, fetch, hono), with Permit2 and EIP-2612 permits. A Cloudflare Worker with a console page. Tests with vitest and an in-process EVM (ethereumjs).
```

## 7. Track (29 characters)

```text
Track 2 Access & Distribution
```

## 8. Chain (18 characters)

```text
Mezo testnet 31611
```

## 9. Status (3 characters)

```text
new
```

## 10. Readiness (7 characters)

```text
testnet
```

## 11. Next three milestones, Wave 2, Nov 2-15 (434 characters)

```text
1. One settlement ledger shared by all Worker instances, so a transaction vouches for one payment everywhere, and a run measured against Cloudflare's real limits (CPU time, subrequests).
2. Spend limits that survive a restart (a daily cap), and an installable MCP server package that an agent host adds with one config line.
3. A ve gauge vote helper, and more pool quotes in the lens as free reads.
Plans, not promises. Testnet only.
```

## 12. Team (97 characters)

```text
Kylne700, solo, building with AI coding agents (Claude Code). GitHub: https://github.com/Kylne700
```

## 13. Description (4,835 characters; allowed 800-5,900)

```text
Mezo Agent Toolkit lets an AI agent read Mezo and pay for those reads in MUSD, with no BTC for gas. It runs on Mezo testnet (chain 31611).
Repo: https://github.com/Kylne700/mezo-agent-toolkit
Live: https://mezo-agent-toolkit.kylne700.workers.dev
Video: {{VIDEO_URL}}
Deck: https://github.com/Kylne700/mezo-agent-toolkit/blob/main/docs/deck.pdf

The problem
Agents can read Mezo, but they cannot pay for the data. One question, such as how healthy a trove is and where it stands in the redemption queue, takes many RPC calls and knowledge of several contracts. An agent that must buy data from someone else also needs a wallet, BTC for gas and a limit on what it may spend.
What it does
1. MezoLens is a read-only contract on Mezo testnet (0xBDfD1C0B544319E25b4b99ee1f355e55230f6130). One eth_call answers one question: trove health, the position in the redemption queue (walked on chain, up to 300 nodes per call), a swap quote with its price impact, or the veBTC and veMEZO locks of a wallet.
2. A pay-per-call HTTP endpoint serves those reads for 0.001 MUSD per call with x402. An unpaid request gets a 402 and the price. The agent signs a permit, the facilitator settles it on Mezo, and the data comes back. The same app runs as a Cloudflare Worker with a console page that lists the latest paid calls, read from the chain.
3. An MCP server (stdio) gives an agent five tools. trove_health, redemption_risk, pool_quote and ve_locks are free reads. pay_and_fetch buys data from x402 servers.

How MUSD is used
MUSD is the unit the reads are priced in and the asset the agent pays with. The buyer signs a Permit2 permit for exactly the price and sends no transaction. The facilitator (facilitator.vativ.io, a third party) sends the transaction to the x402 Permit2 proxy and pays the BTC gas, so the agent pays no gas. On the explorer each payment is one transaction sent by the facilitator, one MUSD Transfer of 0.001 from the agent to the payee, and no change in the agent's BTC balance or nonce. The lens reads TroveManager, SortedTroves, PriceFeed, the pool router, veBTC and veMEZO. The toolkit adds no token and no protocol. It extends what Mezo already has (Track 2, Access & Distribution).

Safety
- Spend limits: pay_and_fetch checks and reserves the amount in MUSD base units before anything is signed. The limits (default 0.01 MUSD per call and 0.1 MUSD per session) and the list of hosts it may pay come only from the server's environment. The tool is off unless the operator gives it a key file. The tool takes a URL and nothing else, so the model cannot raise the limits. A refusal says why and that nothing was paid.
- No double payment: within one server process, if a payment was sent and not confirmed, the buyer does not pay that URL again until the chain shows the first one can no longer land.
- Chain proof: the endpoint asks the chain about every settlement and serves data only when it finds the payment, whatever the facilitator reports. This came from a real failure. Mezo's public RPC sometimes answers null for a mined transaction. The facilitator then reports a failure although the transfer landed. Four payments of 0.001 MUSD were lost to this flake in development, before the final fix.

What was run
173 unit and contract tests in 10 files pass (a fresh run on 2026-10-19). Runs against Mezo testnet: the smoke test (23 checks), a 402-then-200 run on all four paid routes, a real MCP session (29 checks), the Worker under wrangler dev (28 checks) and the Worker deployed on Cloudflare (25 checks, in each of two runs that paid). The console page passed 51 checks in a browser. The video shows two more payments, made to the deployed Worker in one run on 2026-10-19. Their hashes are in the YouTube description and in evidence/video-take-2026-10-19.log. A paid call took 12.7 s and 8.4 s in that run, because the data comes back only after the settlement.

Limits, stated plainly
Testnet only. Nothing here calls Mezo mainnet. The facilitator is a third party: if it is down, paid calls fail, and the free read tools do not depend on it. In the paid runs the agent's BTC balance did not change; a wallet with no BTC at all was not tried. The MCP read tools are free direct lens reads and do not go through x402. A session limit belongs to one server process. The Worker keeps its payment memory per instance, so on Cloudflare its /status did not always show the latest payment. No CPU-limit error or other 5xx answer was seen in the runs of 2026-10-19, but the CPU time per request was not measured. Overruling a reported facilitator failure is covered by offline tests; it has not happened live on the final code.

Next, in Wave 2 (Nov 2-15): one settlement ledger for all Worker instances, spend limits that survive a restart, an installable MCP package and a ve gauge vote helper. Plans, not promises.
```

## 14. Submission comment (2,348 characters; allowed 500-3,000)

```text
Repo https://github.com/Kylne700/mezo-agent-toolkit, live https://mezo-agent-toolkit.kylne700.workers.dev, video {{VIDEO_URL}}, deck https://github.com/Kylne700/mezo-agent-toolkit/blob/main/docs/deck.pdf. Mezo testnet only.

Mezo integration (30). MUSD is both the price and the payment asset: each paid call moves 0.001 MUSD from the agent to the payee, in a transaction the facilitator sends, with no gas from the agent. Two examples from the video, checked on the explorer:
https://explorer.test.mezo.org/tx/0x72589fc2d3fd4b60e4a4bf53cf5c5c99b4c9328ff338ab75f89a48dfa6085a9a
https://explorer.test.mezo.org/tx/0x74482a3e70490754642b63d5de1565d01a508eb4fb3f053fa8f8875314675404
MezoLens is at 0xBDfD1C0B544319E25b4b99ee1f355e55230f6130 and reads TroveManager, SortedTroves, PriceFeed, the pool router, veBTC and veMEZO. The README has a table with each contract, its address, what the toolkit calls on it and why.

Product (30). An agent needs two things from Mezo: cheap reads and a safe way to pay. This gives both behind one MCP config entry, with limits that the operator sets and the agent cannot change. The fee is not a revenue plan. It shows how an agent buys data with MUSD, and anyone can deploy the Worker with their own payee.
Technical (20). 173 tests in 10 files pass (a fresh run). Live checks on testnet: 23 (smoke), 29 (MCP session), 28 (Worker under wrangler dev), 25 (Worker deployed on Cloudflare). The server verifies every settlement on chain itself, because the public RPC sometimes answers null for a mined transaction and the facilitator then reports a failure for a payment that landed. Within a session, the buyer does not pay a URL again while an earlier payment for it may still land.

User experience (10). Every answer carries the block it was read at, with exact integers under raw. A refusal says why and that nothing was paid. The console page passed 51 browser checks with 0 axe-core violations, light and dark at 1280 and 390 px, light at 320 px.

Materials (10). The README links the smoke test, the gate, the MCP session, the Worker run and the console check to their logs in evidence/ and lists the limits (testnet only, a third-party facilitator, per-process memory). The video has captions, no music and a synthetic voice. The deck has 10 slides. The code is MIT, and reused code is credited in the README.
```

## 15. YouTube title (69 characters; allowed up to 100)

```text
Mezo Agent Toolkit: an AI agent reads Mezo and pays in MUSD (testnet)
```

## 16. YouTube description (2,210 characters; allowed up to 5,000)

```text
Mezo Agent Toolkit lets an AI agent read Mezo and pay for those reads in MUSD, with no BTC for gas. Mezo Buildathon Wave 1, Track 2 (Access & Distribution). Mezo testnet only.

What the video shows
- A request without payment gets a 402 and a price of 0.001 MUSD. The agent signs a Permit2 permit, the facilitator settles it on Mezo, and the data comes back.
- The settlement on the Mezo testnet explorer: one MUSD Transfer of 0.001 from the agent to the payee. The agent paid no gas.
- The MCP server with five tools: four free reads through the on-chain lens, and pay_and_fetch, which buys data under limits that the operator sets.
- The spend cap: the first call settles, the second is refused before anything is signed.
- Offline tests of the no-double-payment rule, run with a stub facilitator.
- One lens call that walks 31 positions of the redemption queue, and the console page with the latest paid calls, read from the chain.

Transactions shown in the video (Mezo testnet explorer)
Plain x402 buyer, 0.001 MUSD:
https://explorer.test.mezo.org/tx/0x72589fc2d3fd4b60e4a4bf53cf5c5c99b4c9328ff338ab75f89a48dfa6085a9a
pay_and_fetch through the MCP server, 0.001 MUSD:
https://explorer.test.mezo.org/tx/0x74482a3e70490754642b63d5de1565d01a508eb4fb3f053fa8f8875314675404

Notes
- The scenes that show the request and the two paid calls are drawn from the captured answers of a real run against the deployed Worker and are labelled "Live Worker, 2026-10-19 UTC". The scenes with the free MCP reads and the lens replay a captured real run and are labelled "Recorded run, 2026-10-19 UTC". The test scene is labelled "Offline tests, stub facilitator". Both payments above are real. The explorer page is the real Mezo testnet explorer. The console page is the console of the deployed Worker. Both pages were filmed in a browser.
- The voice is synthetic (Kokoro text-to-speech). The captions are burned in. There is no music.
- The facilitator (facilitator.vativ.io) is a third party. Nothing here calls Mezo mainnet.

Repo: https://github.com/Kylne700/mezo-agent-toolkit
Live (testnet): https://mezo-agent-toolkit.kylne700.workers.dev
Deck: https://github.com/Kylne700/mezo-agent-toolkit/blob/main/docs/deck.pdf
```
