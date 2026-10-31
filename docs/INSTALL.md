# Install the Mezo Agent Toolkit MCP server

The npm package `mezo-agent-toolkit` is the MCP server in one file (`dist/mcp.js`, its libraries are inside it). Nothing is cloned and nothing else is installed: your MCP client runs it with `npx`. It talks to **Mezo testnet (chain 31611)**.

- Twelve read tools work with no key and no funds: `trove_health`, `redemption_risk`, `pool_quote`, `ve_locks`, `ve_status` (the LIVE vote-escrow system, the epoch and one NFT), `gauge_rewards` (the pools ranked by fees per unit of vote weight, and what an NFT can claim), `plan_open`, `plan_top_up` and `plan_repay` (what opening a trove, adding collateral or repaying would do: the exact calldata with sorted-list hints, the ratio after, Recovery Mode, the borrow cap, the redeemable MUSD ahead of the trove, or the reason it is refused), `trove_status` (one trove for any address), `sp_status` (one wallet's Stability Pool deposit, the MUSD it lost to liquidations, its BTC gain, and whether a withdrawal is blocked right now by a trove under the 110% minimum, with the lowest ratio found and how it was found) and `allowance_status` (the non-zero BTC and MUSD allowances one wallet has given, for example before `approve_revoke`).
- `pay_and_fetch` spends testnet MUSD and is **off** until you point `MEZO_KEY_FILE` at a throwaway testnet key (see "Settings").
- Six vote-escrow write tools (`ve_approve_btc`, `ve_lock`, `ve_vote`, `ve_poke`, `ve_claim_rewards`, `ve_claim_rebase`) send real testnet transactions. They are not listed at all until the operator sets `MEZO_WRITE_ENABLE=testnet` (see "Vote-escrow writes"). Three trove write tools (`trove_open`, `trove_add_coll`, `trove_repay`) are listed under the same switch: they plan first and send only what the plan allows. So are five more: `sp_approve_musd` and `sp_deposit` (MUSD into the Stability Pool), `sp_withdraw` (refused with the pool's own reason while a trove is under 110%), `trove_liquidate` (risky: it liquidates a trove under the 110% minimum) and `approve_revoke` (a BTC or MUSD allowance back to 0).

Needs Node.js 22.12 or newer (the package says `^22.12.0 || ^24.0.0 || >=26.0.0`).

## Claude Code

```
claude mcp add mezo -- npx -y mezo-agent-toolkit
```

## Other MCP clients

Most clients take an `mcpServers` entry in a JSON configuration file. The file name and its place depend on the client, so look it up in the client's MCP documentation.

```json
{
  "mcpServers": {
    "mezo": {
      "command": "npx",
      "args": ["-y", "mezo-agent-toolkit"]
    }
  }
}
```

Restart the client after you change its configuration. To pin a version, use `mezo-agent-toolkit@0.2.0` in `args`.

## Check it

```
npx -y mezo-agent-toolkit --doctor
```

The check needs no key. It reads from the RPC and sends no transaction. It prints one line per check and exits with 0 when the RPC answers on chain 31611 and the server lists its tools, and with 1 otherwise. Whether payments are on is reported, not judged: "no" is a normal answer.

```
mezo-agent-toolkit 0.2.0 doctor (node v24.18.0)
ok   rpc       https://rpc.test.mezo.org answered at block 16485201
ok   chain id  31611 (Mezo testnet)
ok   tools     13: trove_health, redemption_risk, pool_quote, ve_locks, ve_status, gauge_rewards, plan_open, plan_top_up, plan_repay, trove_status, sp_status, allowance_status, pay_and_fetch
     writes    enabled: no, no wallet is configured (the operator sets MEZO_KEY_FILE to a file that holds a funded Mezo testnet key)
result: ok
```

`--version` prints the version and `--help` lists the options.

## Settings (all optional)

Set them in the environment of the server. Claude Code takes them with `-e` (write the server name before it):

```
claude mcp add mezo -e MEZO_KEY_FILE=/path/to/testnet.key -- npx -y mezo-agent-toolkit
```

In a JSON configuration, add `"env": { "MEZO_KEY_FILE": "/path/to/testnet.key" }` next to `command` and `args`. `--doctor` reads these variables from your shell, not from the client's configuration, so export them in the terminal to check a setting before the client uses it (for example `MEZO_KEY_FILE=/path/to/testnet.key npx -y mezo-agent-toolkit --doctor`).

| Variable | Meaning | Default |
| --- | --- | --- |
| `MEZO_RPC_URL` | Mezo testnet RPC to read from | `https://rpc.test.mezo.org` |
| `MEZO_KEY_FILE` | Path of a file that holds a funded Mezo testnet private key (64 hex characters). It switches `pay_and_fetch` on. The server reads the file itself and does not print the key. | payments off |
| `MEZO_MAX_PER_CALL_MUSD` | Hard limit for one payment | `0.01` |
| `MEZO_MAX_PER_SESSION_MUSD` | Hard limit for all payments of one server session | `0.1` |
| `MEZO_PAY_ALLOWED_HOSTS` | Comma-separated hosts (or `host:port`) that `pay_and_fetch` may call | the local server on port 8402 and the live Worker |

A limit that does not parse switches payments off instead of falling back to a default. Use a throwaway testnet key and keep the key file outside any repository. The limits cap what the server will sign; they are set by whoever configures the server, not by the model.

## Vote-escrow writes (off by default)

The six `ve_*` write tools work on the LIVE vote-escrow system (veBTC, the pools voter, the rewards distributor); the three `trove_*` write tools call BorrowerOperations (open a trove, add collateral, repay); the five Stability Pool tools call the pool (`sp_deposit`, `sp_withdraw`), the MUSD token (`sp_approve_musd`, and `approve_revoke` on MUSD or BTC) and TroveManager (`trove_liquidate`). No tool argument can set a key, a cap or a gas value: the operator's environment does, and the model cannot change it.

```
claude mcp add mezo -e MEZO_KEY_FILE=/path/to/testnet.key -e MEZO_WRITE_ENABLE=testnet -e MEZO_WRITE_RECEIPTS_FILE=/path/to/receipts.jsonl -e MEZO_WRITE_MAX_BTC_PER_CALL=0.0041 -e MEZO_WRITE_MAX_BTC_PER_DAY=0.0082 -e MEZO_WRITE_RISKY=1 -- npx -y mezo-agent-toolkit
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `MEZO_WRITE_ENABLE` | Exactly `testnet` lists the write tools | off |
| `MEZO_KEY_FILE` | The wallet that signs (the same file that switches `pay_and_fetch` on) | none: every write refuses |
| `MEZO_WRITE_RECEIPTS_FILE` | A JSON-lines file with one line per sent transaction. It is also the daily ledger the caps read | none: every write refuses |
| `MEZO_WRITE_MAX_BTC_PER_CALL`, `MEZO_WRITE_MAX_BTC_PER_DAY` | BTC caps per call and per UTC day. They count the tx value (the collateral of `trove_open` and `trove_add_coll`), the BTC that `ve_approve_btc` allows and that `ve_lock` locks, and the worst-case gas fee (a liquidation moves none of the wallet's funds, so only its gas counts) | `0`: nothing may move |
| `MEZO_WRITE_MAX_MUSD_PER_CALL`, `MEZO_WRITE_MAX_MUSD_PER_DAY` | The same for MUSD: the debt `trove_open` asks for (the 0.1% fee and the 200 MUSD gas reserve come on top), the MUSD `trove_repay` burns, the exact MUSD that `sp_approve_musd` allows and the MUSD that `sp_deposit` and `sp_withdraw` move | `0` |
| `MEZO_WRITE_RISKY` | `1` lets risky actions through. `ve_lock` is one: the BTC stays locked until the unlock time (at most 28 days). So is `trove_open`: the collateral stays in the trove and can be liquidated or redeemed against. So is `trove_liquidate`: it acts on someone else's trove | off |
| `MEZO_POLICY_FILE` | A JSON file that can only tighten the caps, the allow-list and the risky flag | none |
| `MEZO_WRITE_KILL_FILE` | While this file exists, nothing is sent | a file named `STOP` next to the receipts file |

An approve and the lock it pays for each count as the full BTC amount, so locking 0.004 BTC needs a per-day cap above 0.008 BTC plus fees. A lock takes two calls (`ve_approve_btc` for the exact amount, then `ve_lock`) and a vote needs a later block (`ve_vote` says so if the NFT has no voting power yet). What the guards cover, and what they do not, is in [THREAT-MODEL.md](THREAT-MODEL.md).

## Troubleshooting

- **The client cannot start the server.** Run `npx -y mezo-agent-toolkit --doctor` in a terminal. If that works but the client fails, the client may have a different `PATH`: put the full path of `npx` in `command`.
- **`rpc` fails in the check.** The RPC did not answer. Check the network, or set `MEZO_RPC_URL` to another Mezo testnet RPC. The check prints the host of the URL, not its path.
- **`chain id` fails.** `MEZO_RPC_URL` points at a different chain than Mezo testnet (31611).
- **`pay_and_fetch` says it is switched off.** Read `writes` in the check output: it names the reason (no `MEZO_KEY_FILE`, an unreadable key file, or a limit that does not parse). The read tools are not affected.
- **A `ve_*` or `trove_*` write tool refuses.** The answer names the reason and nothing was sent. With `MEZO_WRITE_ENABLE=testnet` exported in your shell, `--doctor` prints a `writes asked for but off:` line when the setup is incomplete (no key file, no receipts file, a cap that does not parse).

## What is in the package

`dist/mcp.js` (the bundled server and command line), `README.md`, `LICENSE` and `server.json` (the MCP registry entry). To build the same file from a clone: `npm ci`, then `npm run build:mcp`.
