// Stdio entry of the MCP server: `npm run mcp`. Stdout carries the protocol and nothing else; notes go to stderr.
// Read tools need nothing. pay_and_fetch is on only when MEZO_KEY_FILE points at a funded Mezo testnet key; its limits come from
// MEZO_MAX_PER_CALL_MUSD (default 0.01) and MEZO_MAX_PER_SESSION_MUSD (default 0.1), and MEZO_PAY_ALLOWED_HOSTS (comma separated hosts, or host:port) lists the hosts it may call; unset, only 127.0.0.1:8402, localhost:8402 and the live Worker (LIVE_HOSTS in mcp-env.ts).
// The six ve write tools (ve_lock, ve_vote, ...), the three trove write tools (trove_open, trove_add_coll, trove_repay) and the five Stability Pool / liquidation / allowance write tools
// (sp_approve_musd, sp_deposit, sp_withdraw, trove_liquidate, approve_revoke) exist only when MEZO_WRITE_ENABLE=testnet; they also need MEZO_KEY_FILE, MEZO_WRITE_RECEIPTS_FILE and non-zero BTC caps (see docs/THREAT-MODEL.md).
// The four trove planners (plan_open, plan_top_up, plan_repay, trove_status), sp_status and allowance_status are reads and always on.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { publicClient } from './clients.ts'
import { createLens } from './lens.ts'
import { buyerFromEnv, veFromEnv } from './mcp-env.ts'
import { createMcpServer } from './mcp-server.ts'
import { createSp } from './sp-actions.ts'
import { createTrove } from './trove-actions.ts'

const chain = publicClient()
const lens = createLens(chain)
const { buyer, offReason } = buyerFromEnv(process.env, chain)
const { ve, writer } = veFromEnv(process.env, chain)
const trove = createTrove(chain, lens, writer)
const sp = createSp(chain, writer)
const server = createMcpServer({ lens, buyer, payOffReason: offReason, ve, trove, sp })
await server.connect(new StdioServerTransport())
console.error(JSON.stringify({ event: 'mcp-ready', lens: lens.address, payments: buyer ? { buyer: buyer.address, limits: buyer.guard.snapshot() } : { off: offReason }, ...(writer ? { veWrites: writer.offReason ? { off: writer.offReason } : { signer: writer.address } } : {}) }))
