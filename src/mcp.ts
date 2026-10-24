// Stdio entry of the MCP server: `npm run mcp`. Stdout carries the protocol and nothing else; notes go to stderr.
// Read tools need nothing. pay_and_fetch is on only when MEZO_KEY_FILE points at a funded Mezo testnet key; its limits come from
// MEZO_MAX_PER_CALL_MUSD (default 0.01) and MEZO_MAX_PER_SESSION_MUSD (default 0.1), and MEZO_PAY_ALLOWED_HOSTS (comma separated hosts, or host:port) lists the hosts it may call; unset, only 127.0.0.1:8402, localhost:8402 and the live Worker (LIVE_HOSTS in mcp-env.ts).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { publicClient } from './clients.ts'
import { createLens } from './lens.ts'
import { buyerFromEnv } from './mcp-env.ts'
import { createMcpServer } from './mcp-server.ts'

const chain = publicClient()
const lens = createLens(chain)
const { buyer, offReason } = buyerFromEnv(process.env, chain)
const server = createMcpServer({ lens, buyer, payOffReason: offReason })
await server.connect(new StdioServerTransport())
console.error(JSON.stringify({ event: 'mcp-ready', lens: lens.address, payments: buyer ? { buyer: buyer.address, limits: buyer.guard.snapshot() } : { off: offReason } }))
