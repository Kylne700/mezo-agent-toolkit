# Threat model: the guarded write path

Scope: `src/signer-env.ts`, `src/policy.ts`, `src/write.ts`, `src/receipts.ts`. Mezo testnet only (chain 31611).
The read-only MCP server does not import these files. A protocol tool will call `createWriter(...).send({ to, data, value })`.

## Assets

- The testnet wallet key (in the file named by `MEZO_KEY_FILE`) and what the wallet holds: BTC, MUSD and positions.
- The operator's limits: the env caps, the policy file and the kill file.
- The receipts file, which is also the daily ledger the caps read.

## Attacker

- Mainly the model that drives the tools, for example after a prompt injection from a web page, a tool result or a chat message. It controls every tool argument, and it can call tools many times or several at once.
- A wrong or hostile RPC endpoint (`MEZO_RPC_URL`). It answers the chain id, the simulation, gas, fees, the nonce and the receipt.
- Out of scope: anyone with shell access to the operator's machine, who can read the key file anyway.

## Guards, and the tests that prove them

Tests are in `test/write.test.ts` (W) and `test/policy.test.ts` (P).

| Guard | How | Test |
|---|---|---|
| Off by default | Writes need `MEZO_WRITE_ENABLE=testnet` exactly, plus `MEZO_KEY_FILE`, `MEZO_WRITE_RECEIPTS_FILE` and a valid policy. Otherwise no RPC call is made at all. | W "without MEZO_WRITE_ENABLE=testnet nothing is read, simulated or sent"; W "no key file, an unreadable key, ..." |
| Testnet only | `eth_chainId` must be 31611. The tx is signed with `CHAIN_ID` from config (EIP-155), never with the RPC's answer. | W "wrong chain: ..."; W happy path (the signed tx has chainId 31611) |
| Allow-list | The contract and the 4-byte selector must match an entry. The shipped `ALLOW` is empty. | P "refuses a contract or a selector ..."; W "a contract or a selector that is not on the allow-list ..." |
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

## Not covered

- **Crash window.** A crash after `eth_sendRawTransaction` but before the receipt line is appended loses that line. After a restart, the day's total misses that tx, so the day can go over by up to one per-call cap.
- **Several processes on one receipts file.** Each writer serializes only its own sends. Two processes can both pass the daily cap and reuse a nonce, so run one writer per wallet.
- **The RPC is trusted** for the simulation, the gas estimate, the nonce and the receipt status. A lying RPC can make a reverting call look fine, so gas is lost (within the caps), or it can report a wrong status. It cannot change the chain id the tx is signed for, and the BTC caps bound the fee it quotes.
- **What a call does on chain is not measured.** The caps only see what the entry's decoder reads from the calldata, plus the value and the fee. Later effects are not seen: an allowance that stays open, liquidation, redemption, price moves. Each new allow-list entry needs review; an approve entry should pin the spender and the amount.
- **The operator is trusted.** Anyone who can edit the env, the policy file or the receipts file can raise the caps or reset the daily total.
- **The day follows the machine's UTC clock.** A wrong clock shifts the day.
- **Real fee estimation** (EIP-1559 fees on the Mezo RPC) is not exercised yet: the tests use a mocked RPC and no real transaction has been sent.
