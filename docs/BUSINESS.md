# Business case and unit economics

**What this proves: the mechanics, on testnet. No real users or mainnet collateral claimed.**

Mezo testnet only (chain 31611), written on 2026-11-05 after the first claim cycle and updated on 2026-11-12 after the second. Testnet fees are not a yield forecast, and testnet BTC and MUSD have no market value. Every number below is in a file of this repo or in a transaction linked from [EVIDENCE.md](../EVIDENCE.md); the one exception is what [The ask](#the-ask) quotes from the judge's review (its posting date and the payment count it gives), which is on our Akindo product page and not in this repo. The gas and payment counts come from [`scripts/w2-economics.ts`](../scripts/w2-economics.ts), which only reads the chain; its saved outputs are [`evidence/w2/b-economics.txt`](../evidence/w2/b-economics.txt) (head block 16578702, 2026-11-05: cycle 1 and 49 payments) and [`evidence/w2/b-economics2.txt`](../evidence/w2/b-economics2.txt) (head block 16723537, 2026-11-12: both cycles and 51 payments). The second claim cycle ran on 2026-11-12: [Cycle 2](#cycle-2-2026-11-12).

## The ask

The Wave 1 judge review on our Akindo product page (posted 2026-10-30) asked for "A clearer business case (who pays and why, when the same reads are free through the MCP tools)". It also said: "All 41 MUSD payments so far are your own test traffic, so getting even a few outside agents or sellers paying in MUSD would strengthen both Integration and Product."

## Short answer

**No outside agent or seller has paid, and the toolkit earns nothing.** We count 51 MUSD payments of 0.001 to the demo payee at block 16723537, and all 51 came from our own wallet ([b-economics2.txt L44-L45](../evidence/w2/b-economics2.txt#L44-L45)). The judge's 41 matches our count of payments mined up to 2026-10-27 ([L46-L49](../evidence/w2/b-economics2.txt#L46-L49)); 10 more were mined later (8 on 2026-11-04, 1 on 2026-11-08, 1 on 2026-11-12), also ours ([L50-L52](../evidence/w2/b-economics2.txt#L50-L52)). The one paid plan call (0.005 MUSD) ran on a local server and our wallet paid itself, so its net cost was zero ([L11](../evidence/w2/e-paid-plan-call.txt#L11), [L25-L26](../evidence/w2/e-paid-plan-call.txt#L25-L26)). The demo payee is a throwaway testnet address ([wrangler.toml](../wrangler.toml)). The toolkit takes no cut and adds no token ([SUBMISSION.md](../SUBMISSION.md), lines 125 and 121).

**The reads stay free.** The MCP server has thirteen free reads, among them the four planners `plan_open`, `plan_top_up`, `plan_repay` and `plan_sp_deposit` ([README](../README.md), line 61, the MCP server item). They cost nothing to call, and the code is MIT ([LICENSE](../LICENSE)). The paid plan route returns the same answer: in our paid call "the paid answer equals the planner's own answer" ([L19](../evidence/w2/e-paid-plan-call.txt#L19)). A developer who can run the MCP server has no reason to pay for a plan, and the free reads do not depend on the facilitator ([SUBMISSION.md](../SUBMISSION.md), line 139).

**Who would pay, and why.** This is the case, not a result: nobody has done it yet. The [deck](deck.pdf) (slide 9) names two roles, and we keep them.

- *Pays: the agent operator.* Someone who gives an AI agent a Mezo wallet and sets its spend limits; the MCP tool `pay_and_fetch` is the buyer side ([README](../README.md), line 61, the MCP server item). Paying for a read or a plan makes sense only when the agent cannot run the toolkit: an agent that can only make HTTP calls, with no Node, no MCP server and no Mezo RPC of its own. It signs a permit for the exact price and sends no transaction. The facilitator, a third party, sends the transaction and pays the BTC gas; in our paid call the wallet's BTC did not change ([L26](../evidence/w2/e-paid-plan-call.txt#L26)). We did not try a wallet with no BTC at all ([SUBMISSION.md](../SUBMISSION.md), line 139). A plan call costs 0.005 MUSD ([L13](../evidence/w2/e-paid-plan-call.txt#L13)). Behind each plan the Worker makes RPC requests: 23 to 26 on 2026-10-31 ([L1](../evidence/w2/e-paid-plan-call.txt#L1), [L6-L8](../evidence/w2/e-paid-plan-call.txt#L6-L8)), and 4 to 9 since the batching change, counted on 2026-11-04 ([README](../README.md), line 273, the bullet on Cloudflare's limits). What that is worth to the buyer: not measured.
- *Gets paid: the data seller.* A team that deploys the Worker with its own payee address and price and sells Mezo reads or plans. In our paid call the settlement holds exactly one MUSD transfer of the full price ([w2:prove L94](../evidence/w2/claim1-w2-prove.txt#L94)). The seller's costs (hosting, RPC reads) were not measured. No seller has tried it.

## Unit economics from our own transactions

Gas is read from each receipt as `gasUsed x effectiveGasPrice`. The ledger's `btc` field is a limit, not the cost. The gas price was 146 wei per gas for every transaction our wallet sent and 130 wei per gas for the facilitator's settlement ([b-economics2.txt L6-L20](../evidence/w2/b-economics2.txt#L6-L20)). All 15 legs are listed in the [appendix](#appendix-gas-per-leg).

### Two claim cycles

| Item | Cycle 1, claimed 2026-11-05 | Cycle 2, claimed 2026-11-12 (source in the cell) | Source (cycle 1) |
|---|---|---|---|
| Transactions | `ve_claim_rebase`, `ve_claim_rewards`, `trove_repay` | `ve_claim_rewards` ([0x81186028…9705](https://explorer.test.mezo.org/tx/0x811860281098a760eb1f718c4fa5ba62d0f9f67947008a6dabc3c4d220669705)) and `trove_repay` ([0xda6a0815…6967](https://explorer.test.mezo.org/tx/0xda6a0815f13dcf753d2a3e484daee62d5d1bb34306e3501e03647f534a746967)); `ve_claim_rebase` was refused and sent nothing | [EVIDENCE.md](../EVIDENCE.md) |
| BTC gas spent | 163045354 wei = 0.000000000163045354 BTC (1116749 gas used) | 63342100 wei = 0.0000000000633421 BTC (433850 gas used), two transactions ([b-economics2.txt L38](../evidence/w2/b-economics2.txt#L38)) | [b-economics.txt L30](../evidence/w2/b-economics.txt#L30) |
| That gas in USD (EST) | 0.000013148158520926 USD. EST, basis: the protocol's PriceFeed at the repay block, 80641.11119 USD per BTC | 0.000004680788374747 USD. EST, basis: the protocol's PriceFeed at the repay block 16723484, 73896.95597 USD per BTC ([b-economics2.txt L40](../evidence/w2/b-economics2.txt#L40)) | [L32](../evidence/w2/b-economics.txt#L32) |
| MUSD claimed, liquid | 13.339052519580378833 MUSD (fees of pool 0) | 13.086605731207608957 MUSD (fees of pool 0) ([b-economics2.txt L39](../evidence/w2/b-economics2.txt#L39), [claim2-fees.txt L15](../evidence/w2/claim2-fees.txt#L15), [w2:prove L127](../evidence/w2/claim2-w2-prove.txt#L127)) | [L31](../evidence/w2/b-economics.txt#L31), [claim1-fees.txt L15](../evidence/w2/claim1-fees.txt#L15), [w2:prove L111](../evidence/w2/claim1-w2-prove.txt#L111) |
| Rebase claimed, added to the lock (not liquid) | 0.000000071972908599 BTC | none: the RewardsDistributor had no rebase to claim for NFT 1729 ([claim2-rebase.txt L4](../evidence/w2/claim2-rebase.txt#L4)) | [claim1-rebase.txt L10](../evidence/w2/claim1-rebase.txt#L10), [w2:prove L103-L104](../evidence/w2/claim1-w2-prove.txt#L103-L104) |
| What we did with the MUSD | repaid the trove with exactly 13.339052519580378833 MUSD | repaid the trove with exactly 13.086605731207608957 MUSD ([b-economics2.txt L37](../evidence/w2/b-economics2.txt#L37), [w2:prove L136](../evidence/w2/claim2-w2-prove.txt#L136)) | [b-economics.txt L29](../evidence/w2/b-economics.txt#L29), [w2:prove L120](../evidence/w2/claim1-w2-prove.txt#L120) |
| Trove debt, before -> after the repay | 2092.15952429055556183 -> 2078.820474422562124548 MUSD | 2079.218477220099478699 -> 2066.131874123899806405 MUSD ([w2:prove L135](../evidence/w2/claim2-w2-prove.txt#L135)) | [w2:prove L119](../evidence/w2/claim1-w2-prove.txt#L119) |
| Trove ratio, before -> after the repay | 174.59% -> 175.71% in the plan (block 16578193); 175.72% when read after; 174.58% when read before the claims (block 16578173, a few blocks earlier) | 161.02% -> 162.04% in the plan (block 16723481); 162.01% when read after; 161.08% when read before the claims (block 16723471, a few blocks earlier) ([claim2-repay.txt L11-L13](../evidence/w2/claim2-repay.txt#L11-L13), [L46](../evidence/w2/claim2-repay.txt#L46), [claim2-before.txt L381](../evidence/w2/claim2-before.txt#L381)) | [claim1-repay.txt L11-L13](../evidence/w2/claim1-repay.txt#L11-L13), [L46](../evidence/w2/claim1-repay.txt#L46), [claim1-before.txt L366](../evidence/w2/claim1-before.txt#L366), [L381](../evidence/w2/claim1-before.txt#L381) |
| Interest owed on the trove before the claim | 0.259421 MUSD on a principal of 2091.900045 MUSD (block 16578173) | 0.397968 MUSD on a principal of 2078.820474 MUSD (block 16723471) ([claim2-before.txt L376-L377](../evidence/w2/claim2-before.txt#L376-L377)) | [claim1-before.txt L366](../evidence/w2/claim1-before.txt#L366), [L376-L377](../evidence/w2/claim1-before.txt#L376-L377) |

Read it with care:

- **Different capital.** The claim comes from a veBTC lock of 0.004 BTC ([w2:prove L20](../evidence/w2/claim1-w2-prove.txt#L20)), for the epoch that ended on 2026-11-05 00:00 UTC ([claim1-before.txt L73](../evidence/w2/claim1-before.txt#L73)); cycle 2 is the epoch that ended on 2026-11-12 00:00 UTC ([claim2-before.txt L73](../evidence/w2/claim2-before.txt#L73)). The trove is a separate position of 0.0453 BTC ([claim1-repay.txt L40](../evidence/w2/claim1-repay.txt#L40)). The interest ran from our last trove transaction (2026-10-31, [w2:prove L51](../evidence/w2/claim1-w2-prove.txt#L51)) to block 16578173 ([claim1-before.txt L366](../evidence/w2/claim1-before.txt#L366)). The same trove, after cycle 1, owed 0.397968 MUSD of interest at block 16723471 ([claim2-before.txt L376-L377](../evidence/w2/claim2-before.txt#L376-L377)) and the cycle 2 repay was 13.086605731207608957 MUSD, so one week of fees was about 33 times that week's interest on this trove (EST, basis: our division of the two figures). We give no ratio and no APR.
- **Where the claimed MUSD comes from.** Pool 0 (MUSD Savings Rate) booked 22464.8801 MUSD of fees in the last epoch ([claim1-before.txt L96](../evidence/w2/claim1-before.txt#L96)). Our vote on it was 0.0036546064 ([L100](../evidence/w2/claim1-before.txt#L100)) and the pool's weight was 6.154882 ([L94](../evidence/w2/claim1-before.txt#L94)), both read at block 16578170 ([L77](../evidence/w2/claim1-before.txt#L77)). 22464.8801 x 0.0036546064 / 6.154882 = 13.3390525746 (EST, basis: our arithmetic from rounded inputs). The chain paid 13.339052519580378833 MUSD ([w2:prove L111](../evidence/w2/claim1-w2-prove.txt#L111)); [L357-L358](../evidence/w2/claim1-before.txt#L357-L358) shows the same amount claimable before we claimed (raw 13339052519580378833). The two agree to eight digits. This explains one claim; it does not predict the next one, because fees and weights change every epoch. Cycle 2 shows it: pool 0 booked 22047.15 MUSD in its last epoch ([claim2-before.txt L96](../evidence/w2/claim2-before.txt#L96)), our vote was the same 0.0036546064 ([L100](../evidence/w2/claim2-before.txt#L100)) and the pool's weight 6.156956 ([L94](../evidence/w2/claim2-before.txt#L94)), read at block 16723468 ([L77](../evidence/w2/claim2-before.txt#L77)); 22047.15 x 0.0036546064 / 6.156956 = 13.0866057012 (EST, basis: our arithmetic from rounded inputs), and the chain paid 13.086605731207608957 MUSD ([w2:prove L127](../evidence/w2/claim2-w2-prove.txt#L127)), so 13.339 became 13.087 with no new vote.
- **The rebase went into the lock.** In cycle 1 it is 0.000000071972908599 BTC ([claim1-rebase.txt L10](../evidence/w2/claim1-rebase.txt#L10)) and is not liquid. In cycle 2 there was none to claim, so that cycle has two transactions, not three.

### One-time setup gas

| Legs (all on 2026-10-31 unless noted) | Gas paid by our wallet | Source |
|---|---|---|
| veBTC approve, lock, vote | 159924604 wei | [b-economics.txt L24](../evidence/w2/b-economics.txt#L24), [ve-agreement.txt L19](../evidence/w2/ve-agreement.txt#L19) |
| Trove open, add collateral, repay 10 MUSD | 189847888 wei | [L25](../evidence/w2/b-economics.txt#L25), [trove-agreement.txt L68](../evidence/w2/trove-agreement.txt#L68) |
| Stability Pool approve, deposit, liquidate | 86716992 wei | [L26](../evidence/w2/b-economics.txt#L26), [a3-agreement.txt L48](../evidence/w2/a3-agreement.txt#L48) |
| Setup total (sum of the three rows) | 436489484 wei | sum |
| Claim cycle 1 (2026-11-05, from the table above) | 163045354 wei | [L30](../evidence/w2/b-economics.txt#L30) |
| Claim cycle 2 (2026-11-12, from the table above) | 63342100 wei | [b-economics2.txt L38](../evidence/w2/b-economics2.txt#L38) |
| All 14 transactions our wallet sent | 662876938 wei = 0.000000000662876938 BTC | [b-economics2.txt L22](../evidence/w2/b-economics2.txt#L22) |

The three setup totals match the totals that the earlier runs wrote down with another method (their agreement files, linked above); the script checks that. The ledger holds one vote, cast on 2026-10-31. If the vote stays in force, as the voter's source says (the comment above `poolsVoterAbi` in [src/abis.ts](../src/abis.ts)), a later cycle costs only the claim and, if we choose, a repay. Cycle 2 on 2026-11-12 did: no new vote was cast, the vote of 2026-10-31 earned fees in the next epoch too ([claim2-before.txt L100](../evidence/w2/claim2-before.txt#L100), [w2:prove L127](../evidence/w2/claim2-w2-prove.txt#L127)), and the cycle cost the claim and the repay.

Capital tied up while this ran: 0.004 BTC in the lock until 2026-11-26 ([w2:prove L20-L21](../evidence/w2/claim1-w2-prove.txt#L20-L21)); 0.0453 BTC of trove collateral against 2066.131874 MUSD of debt after the cycle 2 repay ([claim2-repay.txt L40-L43](../evidence/w2/claim2-repay.txt#L40-L43)); a 10 MUSD deposit in the Stability Pool ([w2:prove L74](../evidence/w2/claim1-w2-prove.txt#L74)).

### Paid plan call: cost and saving

| Item | Value | Source |
|---|---|---|
| Price | 0.005 MUSD per plan call; 0.001 MUSD per read | [e-paid-plan-call.txt L13](../evidence/w2/e-paid-plan-call.txt#L13), [b-economics.txt L36](../evidence/w2/b-economics.txt#L36), [wrangler.toml](../wrangler.toml) |
| Paid by the buyer | 0.005 MUSD; wallet to wallet in our test, so the net cost was zero | [L25-L26](../evidence/w2/e-paid-plan-call.txt#L25-L26) |
| BTC gas of the settlement | 16250000 wei (125000 gas x 130 wei) = 0.00000000001625 BTC, paid by the facilitator | [b-economics.txt L15](../evidence/w2/b-economics.txt#L15) |
| Toolkit's cut | none: the settlement holds exactly one MUSD transfer | [w2:prove L94](../evidence/w2/claim1-w2-prove.txt#L94) |
| RPC requests behind one plan, 2026-10-31 | 24, 23 and 26 for the three plans we dry-ran; 29 RPC requests and 2 facilitator requests for the whole paid call | [L1](../evidence/w2/e-paid-plan-call.txt#L1), [L6-L8](../evidence/w2/e-paid-plan-call.txt#L6-L8), [L16](../evidence/w2/e-paid-plan-call.txt#L16) |
| RPC requests behind one plan, counted 2026-11-04 (after the batching change) | open 8, top-up 9, repay 9, deposit 4 | [README](../README.md), line 273, the bullet on Cloudflare's limits |
| What the buyer saves | not measured | |
| What a seller pays to host it | not measured | |
| Why the facilitator pays the gas | not known to us | |

### Own traffic and outside traffic

| Payments to the demo payee, mined (UTC) | Count | From outside our wallet |
|---|---|---|
| 2026-10-18 | 34 | 0 |
| 2026-10-19 | 5 | 0 |
| 2026-10-24 | 1 | 0 |
| 2026-10-27 | 1 | 0 |
| 2026-11-04 | 8 | 0 |
| 2026-11-08 | 1 | 0 |
| 2026-11-12 | 1 | 0 |
| All (0.051 MUSD) | 51 | 0 |

Source: [b-economics2.txt L43-L53](../evidence/w2/b-economics2.txt#L43-L53), counted at block 16723537 (2026-11-12 00:09 UTC). The paid plan call is not in this table: its payee was our own wallet, so it is a separate payment of 0.005 MUSD ([L25](../evidence/w2/e-paid-plan-call.txt#L25)), also ours.

What the count covers: one payee (the `PAYEE_ADDRESS` of [wrangler.toml](../wrangler.toml)), MUSD `Transfer` events only, blocks 16200000 to 16723537 ([b-economics2.txt L42](../evidence/w2/b-economics2.txt#L42)). The buyer's MUSD came from a swap at block 16229223 ([evidence/swap.json](../evidence/swap.json), MUSD before: 0), so no payment of that wallet is older than the scan. A seller who deploys the Worker with another payee address is not visible to it. 39 payments up to 2026-10-19 is also the figure in [SUBMISSION.md](../SUBMISSION.md), line 125.

## What we did not measure

- The hosting cost of the Worker.
- The BTC gas price on mainnet. The testnet price says nothing about it.
- What a paid plan saves a buyer, in money or in time.
- Demand: how many HTTP-only agents or sellers exist.
- A buyer wallet with no BTC at all.
- Why the facilitator pays the gas, and for how long it will.

## Cycle 2, 2026-11-12

The second claim and repay ran on 2026-11-12, in the first minutes of the new epoch: `ve_claim_rewards` in block 16723475 and `trove_repay` in block 16723484, both with status success ([w2:prove L121-L136](../evidence/w2/claim2-w2-prove.txt#L121-L136)). `ve_claim_rebase` was tried and refused: the RewardsDistributor had no rebase to claim for the NFT then ([claim2-rebase.txt](../evidence/w2/claim2-rebase.txt)). We do not know why; the pre-claim read shows the LIVE system one epoch behind ([claim2-before.txt L14-L15](../evidence/w2/claim2-before.txt#L14-L15)). The figures are in the table above; the files are listed in [EVIDENCE.md](../EVIDENCE.md#proof-2-done-on-2026-11-12-the-next-epochs-fees-then-repay-with-them).

## Appendix: gas per leg

From the receipts of [`evidence/w2/receipts.jsonl`](../evidence/w2/receipts.jsonl): `gasUsed x effectiveGasPrice` ([b-economics2.txt L5-L20](../evidence/w2/b-economics2.txt#L5-L20)). 1 BTC is 10^18 wei. The transaction links are in [EVIDENCE.md](../EVIDENCE.md).

| Leg | Date (UTC) | Block | Gas used | Wei per gas | Fee (wei) | Paid by |
|---|---|---|---|---|---|---|
| ve_approve_btc | 2026-10-31 | 16482800 | 25540 | 146 | 3728840 | our wallet |
| ve_lock | 2026-10-31 | 16482808 | 548254 | 146 | 80045084 | our wallet |
| ve_vote | 2026-10-31 | 16482823 | 521580 | 146 | 76150680 | our wallet |
| trove_open | 2026-10-31 | 16484113 | 578967 | 146 | 84529182 | our wallet |
| trove_add_coll | 2026-10-31 | 16484121 | 371741 | 146 | 54274186 | our wallet |
| trove_repay | 2026-10-31 | 16484130 | 349620 | 146 | 51044520 | our wallet |
| sp_approve_musd | 2026-10-31 | 16485131 | 46382 | 146 | 6771772 | our wallet |
| sp_deposit | 2026-10-31 | 16485134 | 132705 | 146 | 19374930 | our wallet |
| trove_liquidate | 2026-10-31 | 16485146 | 414865 | 146 | 60570290 | our wallet |
| x402_plan_top_up | 2026-10-31 | 16485971 | 125000 | 130 | 16250000 | the facilitator |
| ve_claim_rebase | 2026-11-05 | 16578178 | 665594 | 146 | 97176724 | our wallet |
| ve_claim_rewards | 2026-11-05 | 16578183 | 120311 | 146 | 17565406 | our wallet |
| trove_repay | 2026-11-05 | 16578195 | 330844 | 146 | 48303224 | our wallet |
| ve_claim_rewards | 2026-11-12 | 16723475 | 103006 | 146 | 15038876 | our wallet |
| trove_repay | 2026-11-12 | 16723484 | 330844 | 146 | 48303224 | our wallet |

Re-run: `npx tsx scripts/w2-economics.ts` (no key, no funds, reads only). It exits with 1 if a check fails.
