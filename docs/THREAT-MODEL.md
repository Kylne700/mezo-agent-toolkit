# Threat model: the guarded write path

Scope: `src/signer-env.ts`, `src/policy.ts`, `src/write.ts`, `src/receipts.ts`, and `src/ve-actions.ts`, whose six write tools are the only callers. Mezo testnet only (chain 31611).
The six `ve_*` write tools call `createWriter(...).send({ to, data, value })`. They are registered only when the operator sets `MEZO_WRITE_ENABLE=testnet`. The reads (`ve_status`, `gauge_rewards` and the older tools) never touch the writer.

## Assets

- The testnet wallet key (in the file named by `MEZO_KEY_FILE`) and what the wallet holds: BTC, MUSD and positions.
- The operator's limits: the env caps, the policy file and the kill file.
- The receipts file, which is also the daily ledger the caps read.

## Attacker

- Mainly the model that drives the tools, for example after a prompt injection from a web page, a tool result or a chat message. It controls every tool argument, and it can call tools many times or several at once.
- A wrong or hostile RPC endpoint (`MEZO_RPC_URL`). It answers the chain id, the simulation, gas, fees, the nonce and the receipt.
- Out of scope: anyone with shell access to the operator's machine, who can read the key file anyway.

## Guards, and the tests that prove them

Tests are in `test/write.test.ts` (W), `test/policy.test.ts` (P) and `test/ve.test.ts` (VE).

| Guard | How | Test |
|---|---|---|
| Off by default | Writes need `MEZO_WRITE_ENABLE=testnet` exactly, plus `MEZO_KEY_FILE`, `MEZO_WRITE_RECEIPTS_FILE` and a valid policy. Otherwise no RPC call is made at all. | W "without MEZO_WRITE_ENABLE=testnet nothing is read, simulated or sent"; W "no key file, an unreadable key, ..." |
| Testnet only | `eth_chainId` must be 31611. The tx is signed with `CHAIN_ID` from config (EIP-155), never with the RPC's answer. | W "wrong chain: ..."; W happy path (the signed tx has chainId 31611) |
| Allow-list | The contract and the 4-byte selector must match an entry. The shipped `ALLOW` has six entries, all on the LIVE ve system: BTC `approve` (the spender must be the veBTC, the amount exact and non-zero, never unlimited), veBTC `createLock` (risky, at most 28 days), poolsVoter `vote` (1 to 30 pools, a non-zero weight each), `poke`, `claimFeesAndBribes` (matching lists, at most 60 reward contracts) and RewardsDistributor `claim`. Nothing on the stalled LEGACY contracts, no BTC `transfer`, no NFT `approve` or `transfer`, no `createLockFor`. | P "refuses a contract or a selector ..."; P "the shipped allow-list holds the LIVE ve actions and nothing else" (six entries; each entry; "does not list the other calls an agent could be talked into"); W "a contract or a selector that is not on the allow-list ..." |
| Caps come from the signed bytes | The entry decodes MUSD and BTC from the calldata. The core adds the tx value and the worst-case gas fee (gas limit x maxFeePerGas) as BTC. Caps apply per call and per UTC day. | P "reads the MUSD amount ...", "counts the tx value as BTC ...", "counts the worst-case gas fee ...", "enforces the per-day caps ..."; W "over the per-call ...", "over the per-day cap ...", "an entry that declares no amount ...", "the worst-case gas fee counts ..." |
| Caps fail closed | An unset cap is 0. A per-call cap above its per-day cap, or a number that is not a plain decimal, turns writes off. | P "unset caps are 0 ...", "refuses a per-call cap above its per-day cap ..." |
| No caps from arguments | A request is only `{ to, data, value }`, and any other field is ignored. | W "caps or amounts passed along with a request are ignored" |
| Risky flag | An entry marked risky needs `MEZO_WRITE_RISKY=1` exactly. | P "refuses a risky entry ..."; W "a risky action without MEZO_WRITE_RISKY=1 ..." |
| Policy file only tightens | `MEZO_POLICY_FILE` takes the minimum of the env and file caps. The allow-list can only shrink, and risky can only be turned off. Unknown keys, or a missing or malformed file, turn writes off. The file cannot set the kill path. | P "lowers caps ...", "ignores every attempt to loosen ...", "a set but missing ..."; W "a policy file cannot loosen ..." |
| Kill switch | `MEZO_WRITE_KILL_FILE` (by default a `STOP` file next to the receipts file). It is checked before any RPC call, and again right before signing. | W "kill file present ...", "kill file created while a write is being checked ..." |
| Simulate first | An `eth_call` runs from the signer's address. If it reverts, nothing is sent and no line is written. | W "simulation revert: ..." |
| Gas cap | `eth_estimateGas` must be at most `maxGas` (3,000,000 by default, and the policy file can lower it). The gas limit is min(estimate x 1.2, cap). | W "a gas estimate over the gas cap ..."; W happy path |
| Ledger | Each sent tx gets one JSON line, whatever the outcome (success, reverted or unknown), and every line counts toward the day. A line that cannot be read turns writes off. If the line cannot be written, the process keeps counting the tx in memory. | W "a send error or a receipt timeout is recorded as unknown ...", "... a reverted tx is recorded as reverted"; W "a receipts line it cannot read ..."; P "receipts ledger" |
| One send at a time | Sends are serialized per writer, so each gets its own nonce and two calls cannot both fit under the same daily total. | W "sends run one at a time ..." |
| Key handling | The key is read from a file only, and the write path has no default path. Errors are generic (`readKeyFile`). The tx is signed locally and sent raw, and the key never appears in a result or a receipt line. | W "no result or receipt line contains the key"; `test/package.test.ts` (no key path or key bytes in the bundle) |
| Exact approve | `ve_approve_btc` approves the veBTC only, for the amount asked for, and does nothing if the allowance already is exactly that. The approve amount counts as BTC against the caps, like the lock it pays for. | P "approve: only for veBTC, only an exact non-zero amount, and the amount counts as BTC against the caps"; VE "ve_approve_btc" |
| Lock for ourselves, short, risky | The only lock entry is `createLock`: the NFT is minted to the signer. At most 28 days, a non-zero amount, and `MEZO_WRITE_RISKY=1`. The tool reads the allowance and the balance first and refuses when either is short. | P "lock: a risky action, a non-zero amount, one second to 28 days"; VE "ve_lock" |
| Only our own NFTs | `ve_poke`, `ve_claim_rewards` and `ve_claim_rebase` are sent only for an NFT the signer owns (`ve_vote` also accepts an approved operator). The reward contracts and tokens of a claim are read from the chain, never taken from the tool's arguments. | VE "ve_poke", "ve_claim_rewards", "ve_claim_rebase" |
| Vote only when it will count | `ve_vote` refuses in the first hour of an epoch and in the last (unless the NFT is whitelisted), after a vote in the same epoch, at voting power 0, for a pool without a live gauge and for more than 30 pools. `ve_poke` refuses unless it would raise the weights (a poke re-votes at today's power, which only falls as a lock runs down). Each refusal happens before anything is signed. | VE "ve_vote" ("refuses from what it reads ..."); VE "ve_poke" ("refuses unless ...") |
| A mined tx is never hidden | After a send, the answer carries the receipt and the new state read at the receipt's block. A read that fails, or a receipt that does not arrive, is said in the answer. It never turns a mined tx into an error, and it never shows the state from before the send as the result. | VE "a read-back that fails after the send still reports the mined transaction"; VE "an RPC node that is behind ..." |

## Not covered

- **Crash window.** A crash after `eth_sendRawTransaction` but before the receipt line is appended loses that line. After a restart, the day's total misses that tx, so the day can go over by up to one per-call cap.
- **Several processes on one receipts file.** Each writer serializes only its own sends. Two processes can both pass the daily cap and reuse a nonce, so run one writer per wallet.
- **The RPC is trusted** for the simulation, the gas estimate, the nonce and the receipt status. A lying RPC can make a reverting call look fine, so gas is lost (within the caps), or it can report a wrong status. It cannot change the chain id the tx is signed for, and the BTC caps bound the fee it quotes.
- **What a call does on chain is not measured.** The caps only see what the entry's decoder reads from the calldata, plus the value and the fee. Later effects are not seen: an allowance that stays open, liquidation, redemption, price moves. Each new allow-list entry needs review; the shipped approve entry pins the spender (the veBTC) and an exact amount.
- **The operator is trusted.** Anyone who can edit the env, the policy file or the receipts file can raise the caps or reset the daily total.
- **The day follows the machine's UTC clock.** A wrong clock shifts the day.
- **An approve that is not used.** There is no revoke tool. If `ve_approve_btc` succeeds and the lock is then refused or fails, an allowance of that exact amount stays open for the veBTC contract until a lock uses it up. In the real run the lock used it up (the allowance was 0 afterwards).
- **A vote stands for its epoch.** The voter allows one vote per NFT per epoch, so a vote for a poor pool cannot be changed until the next epoch opens. A vote moves no funds, so the caps do not see it.
- **The claim tools have not sent a real transaction.** An epoch's fees can be claimed once the epoch ends (Thursday 00:00 UTC; the first one that matters ends 2026-11-05). Before that the claims were only simulated on the chain (they return 0), and the tools were tested against a fake chain.
- **The public RPC is several nodes behind one URL.** Right after a send, a node may not know the receipt, the block or the new state yet (seen more than once in the real run). The write tools ask for the receipt again for 15 seconds and read the new state at the receipt's block. The checks before a send read the head the node reports, so a lagging node can let a call through that then reverts on chain; the cost is its gas, and the ledger counts it.
- **Fees on the real chain** were first seen on 2026-10-31 (three real transactions, all succeeded): gas price 146 wei, our `maxFeePerGas` 172 wei, gas used 25,540 (approve), 548,254 (`createLock`) and 521,580 (`vote`), 159,924,604 wei in all (about 1.6e-10 BTC). The caps count gas limit x `maxFeePerGas`, a small overcount. A fee spike has not been seen.
