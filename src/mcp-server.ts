// The MCP server: four free chain reads through the MezoLens contract, and one tool that pays for data over x402 under hard spend limits.
// The factory takes the lens and the buyer as arguments (no files, no environment), so tests run it in memory and the stdio entry (mcp.ts) wires the real ones.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }
import { InputError, addressShape, parseAddress, parseAmountText, parseBool, parseToken, poolShape } from './inputs.ts'
import type { Lens } from './lens.ts'
import { PaymentRefused, type Buyer } from './pay.ts'

export interface McpOptions {
  lens: Lens
  /** Present only when the operator configured a wallet and valid limits. Without it, pay_and_fetch explains why it is off. */
  buyer?: Buyer
  payOffReason?: string
}

const text = (s: string) => [{ type: 'text' as const, text: s }]
const ok = (data: object): CallToolResult => ({ content: text(JSON.stringify(data)), structuredContent: data as Record<string, unknown> })
const fail = (message: string, data?: Record<string, unknown>): CallToolResult => ({ isError: true, content: text(message), ...(data ? { structuredContent: data } : {}) })
const messageOf = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 300)

/** Run a read. Bad input and chain trouble both come back as tool errors the model can read, never as a crash. */
async function read(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (e instanceof InputError) return fail(e.message)
    return fail(`chain read failed, try again: ${messageOf(e)}`)
  }
}

const READ_NOTE = 'Reads Mezo testnet through the MezoLens contract, free and with no key. Amounts are decimal strings; `raw` holds the exact integers (18 decimals). Every answer names the block it was read at.'

export function createMcpServer({ lens, buyer, payOffReason }: McpOptions): McpServer {
  const server = new McpServer(
    { name: 'mezo-agent-toolkit', version: pkg.version },
    { instructions: 'Mezo testnet only. Four free read tools (MUSD troves, the redemption queue, DEX quotes, veBTC and veMEZO locks) and pay_and_fetch, which buys data from x402 endpoints in MUSD under spend limits set by the operator.' },
  )
  const readOnly = { readOnlyHint: true, openWorldHint: true }

  server.registerTool(
    'trove_health',
    {
      title: 'MUSD trove health',
      description: `Health of one MUSD trove (a collateralised loan on Mezo): collateral, debt, collateral ratio, liquidation price and the price drop that would liquidate it. ${READ_NOTE}`,
      inputSchema: addressShape('Owner of the trove'),
      annotations: readOnly,
    },
    ({ address }) => read(() => lens.troveHealth(parseAddress(address))),
  )

  server.registerTool(
    'redemption_risk',
    {
      title: 'MUSD redemption queue position',
      description: `Where one trove stands in the MUSD redemption queue (redemptions take the lowest collateral ratios first): redeemable troves and MUSD ahead of it, whether it is redeemable at all, and the system state. ${READ_NOTE}`,
      inputSchema: addressShape('Owner of the trove'),
      annotations: readOnly,
    },
    ({ address }) => read(() => lens.redemptionRisk(parseAddress(address))),
  )

  server.registerTool(
    'pool_quote',
    {
      title: 'Mezo DEX swap quote',
      description: `Quote a swap on the Mezo DEX: output amount, pool reserves and price impact. Nothing is traded. ${READ_NOTE}`,
      inputSchema: poolShape,
      annotations: readOnly,
    },
    (a) =>
      read(() =>
        lens.poolQuote({
          tokenIn: parseToken(a.tokenIn, 'tokenIn'),
          tokenOut: parseToken(a.tokenOut, 'tokenOut'),
          amountIn: parseAmountText(a.amountIn, 'amountIn'),
          stable: parseBool(a.stable, 'stable'),
        }),
      ),
  )

  server.registerTool(
    've_locks',
    {
      title: 'veBTC and veMEZO locks',
      description: `The veBTC and veMEZO locks (vote-escrow positions) held by one address: amount, unlock time, voting power and whether each has voted. ${READ_NOTE}`,
      inputSchema: addressShape('Wallet that holds the locks'),
      annotations: readOnly,
    },
    ({ address }) => read(() => lens.veLocks(parseAddress(address))),
  )

  const limits = buyer
    ? `Hard limits set by the operator, which you cannot change: at most ${buyer.guard.snapshot().perCallMusd} MUSD per call and ${buyer.guard.snapshot().perSessionMusd} MUSD in total for this session. Anything over is refused before it is signed.`
    : `Currently switched off: ${payOffReason ?? 'no wallet is configured'}.`
  server.registerTool(
    'pay_and_fetch',
    {
      title: 'Pay with MUSD and fetch',
      description:
        `HTTP GET a URL. If the server asks for payment with x402, pay it in MUSD on Mezo testnet and return the data; the buyer needs no BTC for gas. ${limits} ` +
        'Only MUSD on Mezo testnet can be paid. A refusal means nothing was paid. If the answer says a payment may still have been charged, check the balance before paying again. ' +
        'Paid Mezo reads of this toolkit: GET /v1/trove/{address}, /v1/redemption/{address}, /v1/ve/{address} and /v1/pool/quote?tokenIn=&tokenOut=&amountIn= on the server that runs `npm run serve`.',
      inputSchema: { url: z.string().max(2000).describe('Full http:// or https:// address to GET') },
      // Spending is a side effect that cannot be undone, so hosts that honour these hints should ask the user first.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      if (!buyer) {
        const reason = payOffReason ?? 'no wallet is configured'
        return fail(`pay_and_fetch is switched off: ${reason}. The four read tools still work.`, { refused: true, reason })
      }
      try {
        const r = await buyer.fetchPaid(url)
        const out = {
          url: r.url,
          status: r.status,
          ok: r.ok,
          paid: r.paid,
          authorizedMusd: r.authorizedMusd,
          settlement: r.settlement,
          ...(r.unsettled
            ? { unsettled: r.unsettled, warning: `A payment of ${r.authorizedMusd} MUSD was sent but the server did not confirm it. It may still have been charged: check the buyer's MUSD balance or the explorer before paying again.` }
            : {}),
          contentType: r.contentType,
          ...(r.json !== undefined ? { json: r.json } : { body: r.body }),
          bodyTruncated: r.bodyTruncated,
          spend: r.spend,
        }
        return r.ok && !r.unsettled ? ok(out) : { ...ok(out), isError: true }
      } catch (e) {
        const spend = buyer.guard.snapshot()
        if (e instanceof PaymentRefused) return fail(`Refused, nothing was paid: ${e.reason}`, { refused: true, reason: e.reason, spend })
        // An exception means the request failed before any payment left (a failure after it comes back as a result with `unsettled`).
        return fail(`The request was not made and nothing was paid: ${messageOf(e)}`, { refused: false, reason: messageOf(e), spend })
      }
    },
  )

  return server
}
