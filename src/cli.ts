// The npm bin (`npx -y mezo-agent-toolkit`, bundled into dist/mcp.js by scripts/build-mcp.mjs): three flags for people, and anything else starts the stdio MCP server of mcp.ts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pkg from '../package.json' with { type: 'json' }
import { publicClient } from './clients.ts'
import { CHAIN_ID, RPC_URL } from './config.ts'
import { createLens } from './lens.ts'
import { buyerFromEnv, veFromEnv } from './mcp-env.ts'
import { createMcpServer } from './mcp-server.ts'
import { createSp } from './sp-actions.ts'
import { createTrove } from './trove-actions.ts'

const HELP = `mezo-agent-toolkit ${pkg.version}: an MCP server for Mezo testnet (free chain reads, and optional MUSD payments over x402)

  npx -y mezo-agent-toolkit             start the MCP server on stdio (an MCP client runs this for you)
  npx -y mezo-agent-toolkit --doctor    check the RPC, the chain id, the tool list and whether payments or writes are on (needs no key)
  npx -y mezo-agent-toolkit --version
  npx -y mezo-agent-toolkit --help

Claude Code: claude mcp add mezo -- npx -y mezo-agent-toolkit
Environment (all optional): MEZO_RPC_URL, MEZO_KEY_FILE (switches pay_and_fetch on), MEZO_MAX_PER_CALL_MUSD, MEZO_MAX_PER_SESSION_MUSD, MEZO_PAY_ALLOWED_HOSTS
Testnet writes (the ve_*, trove_*, sp_* tools and approve_revoke; off unless MEZO_WRITE_ENABLE=testnet): MEZO_KEY_FILE, MEZO_WRITE_RECEIPTS_FILE, MEZO_WRITE_MAX_{MUSD,BTC}_PER_{CALL,DAY} (unset = 0), MEZO_WRITE_RISKY=1 (needed for ve_lock, trove_open and trove_liquidate), MEZO_POLICY_FILE, MEZO_WRITE_KILL_FILE
More: https://github.com/Kylne700/mezo-agent-toolkit/blob/main/docs/INSTALL.md`

// A viem error's shortMessage leaves out the request URL and body, which can carry an RPC key.
const why = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)

/** One line per check; the exit code is 0 when the RPC answers on chain 31611 and the server lists its tools. Whether payments are on is information, not a failure. */
async function doctor(): Promise<number> {
  let failed = false
  const row = (name: string, ok: boolean, detail: string) => {
    failed ||= !ok
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} ${detail}`)
  }
  console.log(`mezo-agent-toolkit ${pkg.version} doctor (node ${process.version})`)

  const chain = publicClient()
  let host = 'the RPC URL' // origin only below: the path of a private RPC URL can hold a key, and a malformed one is not echoed
  try { host = new URL(RPC_URL).origin } catch { /* the rpc check below fails with a plain message */ }
  try {
    const [id, block] = await Promise.all([chain.getChainId(), chain.getBlockNumber()])
    row('rpc', true, `${host} answered at block ${block}`)
    row('chain id', id === CHAIN_ID, id === CHAIN_ID ? `${id} (Mezo testnet)` : `${id}, expected ${CHAIN_ID}: MEZO_RPC_URL points at another chain`)
  } catch (e) {
    row('rpc', false, `${host} did not answer: ${why(e)}`)
  }

  try {
    const { buyer, offReason } = buyerFromEnv(process.env, chain)
    const { ve, writer } = veFromEnv(process.env, chain)
    const lens = createLens(chain)
    const server = createMcpServer({ lens, buyer, payOffReason: offReason, ve, trove: createTrove(chain, lens, writer), sp: createSp(chain, writer) })
    const client = new Client({ name: 'doctor', version: pkg.version })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    row('tools', tools.length > 0, `${tools.length}: ${tools.map((t) => t.name).join(', ')}`)
    // The tools that spend or send: pay_and_fetch (MUSD) and the ve, trove and Stability Pool write tools (testnet transactions). Widen this when more tools can write.
    const on = [buyer && 'pay_and_fetch can spend MUSD within the operator limits', writer && !writer.offReason && 'the ve, trove and Stability Pool write tools can send testnet transactions within the write caps'].filter(Boolean)
    console.log(`     writes    enabled: ${on.length > 0 ? `yes, ${on.join('; ')}` : `no, ${offReason}`}`)
    if (writer?.offReason) console.log(`     writes asked for but off: ${writer.offReason}`)
  } catch (e) {
    row('tools', false, why(e))
  }

  console.log(failed ? 'result: FAIL' : 'result: ok')
  return failed ? 1 : 0
}

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') console.log(HELP)
else if (arg === '--version' || arg === '-v') console.log(pkg.version)
else if (arg === '--doctor') process.exitCode = await doctor()
else await import('./mcp.ts')
