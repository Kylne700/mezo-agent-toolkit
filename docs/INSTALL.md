# Install the Mezo Agent Toolkit MCP server

The npm package `mezo-agent-toolkit` is the MCP server in one file (`dist/mcp.js`, its libraries are inside it). Nothing is cloned and nothing else is installed: your MCP client runs it with `npx`. It talks to **Mezo testnet (chain 31611)**.

- Four read tools work with no key and no funds: `trove_health`, `redemption_risk`, `pool_quote`, `ve_locks`.
- `pay_and_fetch` spends testnet MUSD and is **off** until you point `MEZO_KEY_FILE` at a throwaway testnet key (see "Settings").

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
ok   rpc       https://rpc.test.mezo.org answered at block 16479784
ok   chain id  31611 (Mezo testnet)
ok   tools     5: trove_health, redemption_risk, pool_quote, ve_locks, pay_and_fetch
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

## Troubleshooting

- **The client cannot start the server.** Run `npx -y mezo-agent-toolkit --doctor` in a terminal. If that works but the client fails, the client may have a different `PATH`: put the full path of `npx` in `command`.
- **`rpc` fails in the check.** The RPC did not answer. Check the network, or set `MEZO_RPC_URL` to another Mezo testnet RPC. The check prints the host of the URL, not its path.
- **`chain id` fails.** `MEZO_RPC_URL` points at a different chain than Mezo testnet (31611).
- **`pay_and_fetch` says it is switched off.** Read `writes` in the check output: it names the reason (no `MEZO_KEY_FILE`, an unreadable key file, or a limit that does not parse). The four read tools are not affected.

## What is in the package

`dist/mcp.js` (the bundled server and command line), `README.md`, `LICENSE` and `server.json` (the MCP registry entry). To build the same file from a clone: `npm ci`, then `npm run build:mcp`.
