// The MCP server: four free chain reads through the MezoLens contract, one tool that pays for data over x402 under hard spend limits,
// two free reads of the LIVE vote-escrow system (ve_status, gauge_rewards) and, only when the operator turns writes on, six guarded write tools.
// The factory takes the lens, the buyer and the ve tools as arguments (no files, no environment), so tests run it in memory and the stdio entry (mcp.ts) wires the real ones.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }
import { InputError, addressShape, parseAddress, parseAmountText, parseBool, parseToken, poolShape } from './inputs.ts'
import type { Lens } from './lens.ts'
import { PaymentRefused, type Buyer } from './pay.ts'
import type { Outcome, Ve } from './ve-actions.ts'

export interface McpOptions {
  lens: Lens
  /** Present only when the operator configured a wallet and valid limits. Without it, pay_and_fetch explains why it is off. */
  buyer?: Buyer
  payOffReason?: string
  /** The LIVE vote-escrow tools. Without it, ve_status and gauge_rewards are not offered; its `write` part exists only when the operator enabled writes. */
  ve?: Ve
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

/** Run a write tool. A refusal means nothing was sent; a sent tx that did not succeed is an error result that still carries the hash. */
async function write(fn: () => Promise<Outcome>): Promise<CallToolResult> {
  try {
    const r = await fn()
    if (!r.sent) return fail(`Refused, nothing was sent: ${r.reason}`, { sent: false, reason: r.reason })
    if (r.status === 'success') return ok(r)
    const warning = r.status === 'reverted' ? 'The transaction was mined and reverted: it changed nothing and cost gas.' : 'No receipt arrived in time: the transaction may still be mined. Check the hash on the explorer before sending anything again.'
    return { ...ok({ ...r, warning }), isError: true }
  } catch (e) {
    if (e instanceof InputError) return fail(e.message)
    return fail(`The tool failed (${messageOf(e)}). If a transaction may have been sent, check the receipts file and the chain before trying again.`)
  }
}

const READ_NOTE = 'Reads Mezo testnet through the MezoLens contract, free and with no key. Amounts are decimal strings; `raw` holds the exact integers (18 decimals). Every answer names the block it was read at.'

export function createMcpServer({ lens, buyer, payOffReason, ve }: McpOptions): McpServer {
  const server = new McpServer(
    { name: 'mezo-agent-toolkit', version: pkg.version },
    {
      instructions:
        `Mezo testnet only. ${ve ? 'Six' : 'Four'} free read tools (MUSD troves, the redemption queue, DEX quotes, veBTC and veMEZO locks${ve ? ', the LIVE vote-escrow status, gauge rewards' : ''}) and pay_and_fetch, which buys data from x402 endpoints in MUSD under spend limits set by the operator.` +
        (ve?.write ? ' Six more tools (ve_approve_btc, ve_lock, ve_vote, ve_poke, ve_claim_rewards, ve_claim_rebase) send real testnet transactions through a guarded writer, under allow-list and caps the operator set.' : ''),
    },
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

  if (ve) {
    const w = ve.write
    const tokenId = z.string().optional().describe('A veBTC NFT id on the LIVE system, for example "1727" (optional)')
    server.registerTool(
      've_status',
      {
        title: 'Vote-escrow status (LIVE vs LEGACY)',
        description: `The LIVE vote-escrow system (veBTC, poolsVoter, RewardsDistributor) next to the LEGACY one, and which of them still distributes (from each distributor's activePeriod); the current epoch with its voting window and phase; and, with a tokenId, one NFT's lock, voting power, voted flag, last vote time and why it can or cannot vote now. ${READ_NOTE}`,
        inputSchema: { tokenId },
        annotations: readOnly,
      },
      (a) => read(() => ve.status({ tokenId: a.tokenId })),
    )
    server.registerTool(
      'gauge_rewards',
      {
        title: 'Gauge rewards and pool ranking',
        description: `Every pool of the LIVE voter ranked by MUSD fees booked this epoch per unit of vote weight and, with a tokenId, what that NFT can claim now (fee and bribe rewards per gauge and token) and its vote on each pool. ${READ_NOTE}`,
        inputSchema: { tokenId },
        annotations: readOnly,
      },
      (a) => read(() => ve.rewards({ tokenId: a.tokenId })),
    )
    if (w) {
      // Every write is a real testnet transaction through the guarded writer; hosts that honour these hints should ask the user first.
      const sends = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      const WRITE_NOTE = 'Sends a real Mezo testnet transaction through the guarded writer: the operator\'s allow-list, spend caps and kill file apply, and every send is recorded. A refusal means nothing was sent.'
      const id = { tokenId: z.string().describe('A veBTC NFT id on the LIVE system that the wallet owns, for example "1727"') }
      server.registerTool(
        've_approve_btc',
        {
          title: 'Approve BTC for veBTC (exact amount)',
          description: `Let the LIVE veBTC pull exactly this much BTC from the operator's wallet, so ve_lock can create a lock. The amount is exact (an unlimited approval is refused) and the next lock uses it up. ${WRITE_NOTE}`,
          inputSchema: { amount: z.string().describe('BTC to approve as a plain decimal, for example "0.004"') },
          annotations: sends,
        },
        (a) => write(() => w.approveBtc({ amount: a.amount })),
      )
      server.registerTool(
        've_lock',
        {
          title: 'Lock BTC in veBTC',
          description: `Lock BTC in the LIVE veBTC for up to 28 days (the end is rounded down to a Thursday 00:00Z) and receive a veBTC NFT. Needs a ve_approve_btc for the same amount first. The BTC stays locked until the end. Voting power is 0 in the block the NFT arrives, so vote in a later block. ${WRITE_NOTE}`,
          inputSchema: { amount: z.string().describe('BTC to lock as a plain decimal, for example "0.004"'), days: z.number().describe('Lock length in whole days, 1 to 28') },
          annotations: sends,
        },
        (a) => write(() => w.lock({ amount: a.amount, days: a.days })),
      )
      server.registerTool(
        've_vote',
        {
          title: 'Vote with a veBTC NFT',
          description: `Vote with one NFT for pools on the LIVE voter (see gauge_rewards for the pools). Weights are relative whole numbers: one pool with weight 100 is a 100% vote. One vote per NFT per epoch; votes are refused in the first and last hour of an epoch and when the NFT's voting power is 0. The vote stays in force until the NFT votes again. ${WRITE_NOTE}`,
          inputSchema: { ...id, pools: z.array(z.object({ pool: z.string().describe('Pool address (0x)'), weight: z.number().describe('Relative weight, a whole number from 1 to 10000') })).describe('Pools to vote for, at most 30, no pool twice') },
          annotations: sends,
        },
        (a) => write(() => w.vote({ tokenId: a.tokenId, pools: a.pools })),
      )
      server.registerTool(
        've_poke',
        {
          title: 'Refresh a vote at the current power',
          description: `Re-apply an NFT's stored vote at its current voting power. Only useful after the lock grew; it is refused when it would not raise the weights. ${WRITE_NOTE}`,
          inputSchema: id,
          annotations: sends,
        },
        (a) => write(() => w.poke({ tokenId: a.tokenId })),
      )
      server.registerTool(
        've_claim_rewards',
        {
          title: 'Claim gauge fees and bribes',
          description: `Claim every fee and bribe reward an NFT has earned on the LIVE voter. The reward contracts and tokens are read from the chain (see gauge_rewards). Rewards booked in an epoch can be claimed once it ends. ${WRITE_NOTE}`,
          inputSchema: id,
          annotations: sends,
        },
        (a) => write(() => w.claimRewards({ tokenId: a.tokenId })),
      )
      server.registerTool(
        've_claim_rebase',
        {
          title: 'Claim the veBTC rebase',
          description: `Claim the rebase the LIVE RewardsDistributor holds for an NFT. Refused when there is nothing to claim. ${WRITE_NOTE}`,
          inputSchema: id,
          annotations: sends,
        },
        (a) => write(() => w.claimRebase({ tokenId: a.tokenId })),
      )
    }
  }

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
        return fail(`pay_and_fetch is switched off: ${reason}. The read tools still work.`, { refused: true, reason })
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
            ? { unsettled: r.unsettled, warning: `A payment of ${r.authorizedMusd} MUSD was sent but the server did not confirm it. It may still have been charged: check the buyer's MUSD balance or the explorer. This URL is not paid for again until the chain shows that payment can no longer land.` }
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
