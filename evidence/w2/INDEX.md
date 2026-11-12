# Index of evidence/w2/

One row per file in this folder (61 files besides this index): what it shows, the transactions it covers (explorer links) and the date. The dates are the days the files were committed; the ledger spans three days. All 16 transactions are in [EVIDENCE.md](../../EVIDENCE.md#the-transactions) with their blocks and what each one does. Every link on this page is checked by `npm run w2:check`.

Everything here is Mezo testnet (chain 31611). Nothing here is mainnet.

| File | What it shows | Transactions | Date |
|---|---|---|---|
| [a1-live-reads.txt](a1-live-reads.txt) | Read-only reads before any write: code exists at every vote-escrow address in src/config.ts, and the live reads for NFT 1727 at block 16481554. | none | 2026-10-31 |
| [a3-agreement.txt](a3-agreement.txt) | 50 PASS, 0 FAIL: checks run after the Stability Pool legs (approve, deposit, liquidate, the refused withdraw, the revoke that was not needed) against the chain at the receipt blocks. | none | 2026-10-31 |
| [a3-balances.txt](a3-balances.txt) | Wallet BTC, MUSD and nonce before and after the Stability Pool run. | none | 2026-10-31 |
| [a3-before.txt](a3-before.txt) | trove_status through the MCP stdio entry and direct reads, before any Stability Pool transaction. | none | 2026-10-31 |
| [a3-liquidate-after.txt](a3-liquidate-after.txt) | Reads at the receipt block 16485146 and the block before it, after trove_liquidate of the lowest trove. | [0x2eba8e07…dace](https://explorer.test.mezo.org/tx/0x2eba8e0781420e3ea41dd2189d10ac7e7607530b4b0b3bb1eb37dbb70246dace) | 2026-10-31 |
| [a3-liquidate-before.txt](a3-liquidate-before.txt) | Reads at block 16485143, just before trove_liquidate of the lowest trove. | none | 2026-10-31 |
| [a3-liquidate-tx.txt](a3-liquidate-tx.txt) | The trove_liquidate tool call and its answer (2026-10-31T12:43Z). | [0x2eba8e07…dace](https://explorer.test.mezo.org/tx/0x2eba8e0781420e3ea41dd2189d10ac7e7607530b4b0b3bb1eb37dbb70246dace) | 2026-10-31 |
| [a3-revoke-before.txt](a3-revoke-before.txt) | allowance_status (the tool) and direct allowance reads before the revoke leg. | none | 2026-10-31 |
| [a3-revoke.txt](a3-revoke.txt) | No non-zero BTC or MUSD allowance existed, so approve_revoke sent no transaction; the read shows 0. | none | 2026-10-31 |
| [a3-sp-after.txt](a3-sp-after.txt) | sp_status through the MCP stdio entry at the end of the Stability Pool run (block 16485179). | none | 2026-10-31 |
| [a3-sp-before-withdraw.txt](a3-sp-before-withdraw.txt) | sp_status just before the first sp_withdraw attempt (refused; no transaction). | none | 2026-10-31 |
| [a3-sp-before-withdraw2.txt](a3-sp-before-withdraw2.txt) | sp_status just before the second sp_withdraw attempt (refused; no transaction). | none | 2026-10-31 |
| [a3-sp-txs.txt](a3-sp-txs.txt) | The sp_approve_musd and sp_deposit tool calls and their answers. | [0x61f55d46…a78a](https://explorer.test.mezo.org/tx/0x61f55d466fe3a9675d2adc16a377d0a2553807283ac2ef90261dfe0abe39a78a)<br>[0xce607af0…4b5a](https://explorer.test.mezo.org/tx/0xce607af072d221d11b54438604ae1d93a8e1977ce8ee02d19f74dd3f38904b5a) | 2026-10-31 |
| [a3-trove-after.txt](a3-trove-after.txt) | The wallet trove before and after the Stability Pool transactions (direct TroveManager reads). | none | 2026-10-31 |
| [a3-ve-1729-after.txt](a3-ve-1729-after.txt) | ve_status for NFT 1729 through the MCP stdio entry, after the Stability Pool transactions (read only). | none | 2026-10-31 |
| [a3-ve-1729-before.txt](a3-ve-1729-before.txt) | ve_status for NFT 1729 through the MCP stdio entry, before any Stability Pool transaction (read only). | none | 2026-10-31 |
| [a3-w2-prove.txt](a3-w2-prove.txt) | `npm run w2:prove` (no key) run after the Stability Pool transactions, on the ledger as it was then. | 10 of the 14 (all linked in [EVIDENCE.md](../../EVIDENCE.md#the-transactions)) | 2026-10-31 |
| [a3-withdraw.txt](a3-withdraw.txt) | A read-only simulation (eth_call from the wallet) of withdrawFromSP(1 MUSD) reverted; nothing was sent. | none | 2026-10-31 |
| [b-economics.txt](b-economics.txt) | Claim-cycle economics at block 16578702: gas of the cycle 163045354 wei, 13.339052519580378833 MUSD claimed and the same amount repaid. | none | 2026-11-05 |
| [claim1-after.txt](claim1-after.txt) | Wallet and ve_status after the 2026-11-05 claims and repay. | none | 2026-11-05 |
| [claim1-before.txt](claim1-before.txt) | Wallet and ve_status before the 2026-11-05 claims. | none | 2026-11-05 |
| [claim1-fees.txt](claim1-fees.txt) | The ve_claim_rewards tool call and its answer (2026-11-05). | [0x904762d6…c32e](https://explorer.test.mezo.org/tx/0x904762d69d7b4d2ea00d65d98e7c1c16145f8be16e68167142875bb2316dc32e) | 2026-11-05 |
| [claim1-rebase.txt](claim1-rebase.txt) | The ve_claim_rebase tool call and its answer (2026-11-05). | [0xebd0e10d…a8b2](https://explorer.test.mezo.org/tx/0xebd0e10d3206301284ecf7340df28184a8b2b64c62f1dd0b85fa6b21568fa8b2) | 2026-11-05 |
| [claim1-repay.txt](claim1-repay.txt) | The trove_repay tool call that repaid with the claimed 13.339052519580378833 MUSD, and its answer (2026-11-05). | [0x57c61107…fc85](https://explorer.test.mezo.org/tx/0x57c61107c7b9c08a1a2566506b05d506231219c918c4e60b4a23d1ebae01fc85) | 2026-11-05 |
| [claim1-w2-prove.txt](claim1-w2-prove.txt) | `npm run w2:prove` (no key) at block 16578215: 14 PASS, 0 FAIL, 0 SKIP. Each ledger transaction and the lens deploy re-read from the chain. | 14 of the 14 (all linked in [EVIDENCE.md](../../EVIDENCE.md#the-transactions)) | 2026-11-05 |
| [claim2-after.txt](claim2-after.txt) | Wallet and ve_status after the 2026-11-12 claim and repay. | none | 2026-11-12 |
| [claim2-before.txt](claim2-before.txt) | Wallet and ve_status before the 2026-11-12 claim. | none | 2026-11-12 |
| [claim2-fees.txt](claim2-fees.txt) | The ve_claim_rewards tool call and its answer (2026-11-12). | [0x81186028…9705](https://explorer.test.mezo.org/tx/0x811860281098a760eb1f718c4fa5ba62d0f9f67947008a6dabc3c4d220669705) | 2026-11-12 |
| [claim2-rebase.txt](claim2-rebase.txt) | The ve_claim_rebase tool call and its answer (2026-11-12): refused, the RewardsDistributor had no rebase to claim, nothing sent. | none | 2026-11-12 |
| [claim2-repay.txt](claim2-repay.txt) | The trove_repay tool call that repaid with the claimed 13.086605731207608957 MUSD, and its answer (2026-11-12). | [0xda6a0815…6967](https://explorer.test.mezo.org/tx/0xda6a0815f13dcf753d2a3e484daee62d5d1bb34306e3501e03647f534a746967) | 2026-11-12 |
| [claim2-w2-prove.txt](claim2-w2-prove.txt) | `npm run w2:prove` (no key) at block 16723493: 16 PASS, 0 FAIL, 0 SKIP. Each ledger transaction and the lens deploy re-read from the chain. | 16 of the 16 (all linked in [EVIDENCE.md](../../EVIDENCE.md#the-transactions)) | 2026-11-12 |
| [e-paid-plan-call.txt](e-paid-plan-call.txt) | One real paid plan call over x402: our wallet paid its own server 0.005 MUSD; the facilitator sent the transaction. | [0x69338353…624d](https://explorer.test.mezo.org/tx/0x693383537b0b2d9f76d07626db79fce23c19a9224575a80e81433d3694a5624d) | 2026-10-31 |
| [e-paid-plan-top-up.json](e-paid-plan-top-up.json) | The JSON answer of the paid POST /plan/top-up call (price $0.005). | [0x69338353…624d](https://explorer.test.mezo.org/tx/0x693383537b0b2d9f76d07626db79fce23c19a9224575a80e81433d3694a5624d) | 2026-10-31 |
| [e-w2-prove.txt](e-w2-prove.txt) | `npm run w2:prove` (no key) run after the paid plan call. | 11 of the 14 (all linked in [EVIDENCE.md](../../EVIDENCE.md#the-transactions)) | 2026-10-31 |
| [economics-2026-11-11.txt](economics-2026-11-11.txt) | Payer count re-read from the chain at block 16714465: 50 payments to the demo payee, all from our wallet; outside payers 0 (made by `scripts/w2-economics.ts`). | none | 2026-11-11 |
| [install-release-2026-11-11.txt](install-release-2026-11-11.txt) | `--doctor` of the v0.2.0 release tarball, run from an empty directory, empty HOME and empty npm cache: result ok, 14 tools, writes off. | none | 2026-11-11 |
| [install.txt](install.txt) | Install proof of a build from the committed tree on 2026-10-31 (5 tools, Wave 1 lens). Superseded by install-release-2026-11-11.txt. | none | 2026-10-31 |
| [lens-redeploy.txt](lens-redeploy.txt) | MezoLens redeployed on the live vote-escrow system: deploy transaction, address 0x659203438789Ce052a9148Ef5A807508ab5eE40c, explorer verification. | [0x5342268a…f3cb](https://explorer.test.mezo.org/tx/0x5342268ad642bbc386da866a7626f4d7708f4a0f7cff0a608bb5d448b132f3cb) | 2026-10-31 |
| [receipts.jsonl](receipts.jsonl) | The ledger: one line per real transaction the write core logged (15 lines), with sender, target, nonce, selector, gas and amounts. | 15 of the 16 (all linked in [EVIDENCE.md](../../EVIDENCE.md#the-transactions)) | 2026-10-31 to 2026-11-12 |
| [trove-agreement.txt](trove-agreement.txt) | 96 PASS, 1 FAIL over two runs of the same checks. The FAIL (line 67) is a driver check that counted the countdown field epoch.secondsToNext as a change; line 71 explains it, and the second run passes (line 99). | none | 2026-10-31 |
| [trove-plan-open-pre.txt](trove-plan-open-pre.txt) | plan_open (read only, nothing sent), 0.045 BTC against 1900 MUSD. | none | 2026-10-31 |
| [trove-plan-open.txt](trove-plan-open.txt) | plan_open (read only) just before the real trove_open. | none | 2026-10-31 |
| [trove-plan-repay.txt](trove-plan-repay.txt) | plan_repay (read only) just before the real trove_repay. | none | 2026-10-31 |
| [trove-plan-topup.txt](trove-plan-topup.txt) | plan_top_up (read only) just before the real trove_add_coll. | none | 2026-10-31 |
| [trove-status-after.txt](trove-status-after.txt) | trove_status for the wallet after the three trove transactions. | none | 2026-10-31 |
| [trove-status-before.txt](trove-status-before.txt) | trove_status for the wallet before any trove transaction. | none | 2026-10-31 |
| [trove-txs.txt](trove-txs.txt) | The trove_open, trove_add_coll and trove_repay tool calls and their answers. | [0xd908acf9…5cbc](https://explorer.test.mezo.org/tx/0xd908acf9d8527f1b2aed152b94f739defe3d1ecaea3db17580ff69be17995cbc)<br>[0x27768c21…855b](https://explorer.test.mezo.org/tx/0x27768c211b44e98431f15076626191b14f29fc454abd5a131386b4ee9502855b)<br>[0x03f45c0e…054e](https://explorer.test.mezo.org/tx/0x03f45c0e57b1dbbaed3d75ef37aa8bca28723e70a8c9286ba3c8a8166d01054e) | 2026-10-31 |
| [v-smoke-rpc.txt](v-smoke-rpc.txt) | The repo smoke test (read only, no key) with RPC receipts: SMOKE PASSED. | none | 2026-10-31 |
| [ve-1729-after-trove.txt](ve-1729-after-trove.txt) | ve_status for NFT 1729 after the three trove transactions (read only). | none | 2026-10-31 |
| [ve-1729-before-trove.txt](ve-1729-before-trove.txt) | ve_status for NFT 1729 before any trove transaction (read only). | none | 2026-10-31 |
| [ve-1729-compare.txt](ve-1729-compare.txt) | The before and after reads of NFT 1729 compared on the fields that should not move. | none | 2026-10-31 |
| [ve-1729-votes-before-trove.txt](ve-1729-votes-before-trove.txt) | Direct PoolsVoter reads for NFT 1729 before any trove transaction. | none | 2026-10-31 |
| [ve-agreement.txt](ve-agreement.txt) | 19 PASS, 0 FAIL: checks run after the vote-escrow legs, including voted(1729) true on chain at block 16482891 (direct read). | none | 2026-10-31 |
| [ve-budget.txt](ve-budget.txt) | Wallet BTC before and after the vote-escrow run, and the difference. | [0x52c8e63a…7b26](https://explorer.test.mezo.org/tx/0x52c8e63ad219c682f2630839530ef9c9a2f311a8b51843b762741ccbb1387b26)<br>[0xfed42ec9…1c2c](https://explorer.test.mezo.org/tx/0xfed42ec9a5d3cb7390ef9e216df8e9249733692863878d260ac833dfe4231c2c)<br>[0xaca4dfa5…e897](https://explorer.test.mezo.org/tx/0xaca4dfa53ad82d7b91c6591cc1d3aaa2dc491125e74ca39efc52b90791d4e897) | 2026-10-31 |
| [ve-claim-sim.txt](ve-claim-sim.txt) | Claim simulations at the head block (eth_call with a from address); no transaction was sent. | none | 2026-10-31 |
| [ve-locks-agreement.txt](ve-locks-agreement.txt) | ve_locks (the new lens) for our wallet against direct veBTC reads at the same block. | none | 2026-10-31 |
| [ve-ranking.txt](ve-ranking.txt) | gauge_rewards ranking at block 16482789 (epoch of 2026-10-29): MUSD fees booked per unit, used to choose the pool to vote for. | none | 2026-10-31 |
| [ve-rewards-after.txt](ve-rewards-after.txt) | gauge_rewards with our NFT after the vote. | none | 2026-10-31 |
| [ve-status-after.txt](ve-status-after.txt) | ve_status with our NFT through the MCP stdio entry, after the vote. | none | 2026-10-31 |
| [ve-status-before.txt](ve-status-before.txt) | ve_status (no tokenId) through the MCP stdio entry, before any vote-escrow transaction of this run. | none | 2026-10-31 |
| [ve-txs.txt](ve-txs.txt) | The ve_approve_btc, ve_lock and ve_vote tool calls and their answers. | [0x52c8e63a…7b26](https://explorer.test.mezo.org/tx/0x52c8e63ad219c682f2630839530ef9c9a2f311a8b51843b762741ccbb1387b26)<br>[0xfed42ec9…1c2c](https://explorer.test.mezo.org/tx/0xfed42ec9a5d3cb7390ef9e216df8e9249733692863878d260ac833dfe4231c2c)<br>[0xaca4dfa5…e897](https://explorer.test.mezo.org/tx/0xaca4dfa53ad82d7b91c6591cc1d3aaa2dc491125e74ca39efc52b90791d4e897) | 2026-10-31 |
