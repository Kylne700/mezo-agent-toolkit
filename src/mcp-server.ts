// The MCP server: four free chain reads through the MezoLens contract, one tool that pays for data over x402 (GET or POST) under hard spend limits,
// two free reads of the LIVE vote-escrow system (ve_status, gauge_rewards), four free trove planners (plan_open, plan_top_up, plan_repay, trove_status),
// three free tools for the Stability Pool: its status, the token allowances and a deposit plan (sp_status, allowance_status, plan_sp_deposit) and, only when the operator turns writes on, fourteen guarded write tools
// (six vote-escrow, three trove, five Stability Pool / liquidation / allowance).
// The factory takes the lens, the buyer, the ve, trove and Stability Pool tools as arguments (no files, no environment), so tests run it in memory and the stdio entry (mcp.ts) wires the real ones.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }
import { InputError, addressShape, parseAddress, parseAmountText, parseBool, parseToken, poolShape } from './inputs.ts'
import type { Lens } from './lens.ts'
import { PaymentRefused, type Buyer } from './pay.ts'
import type { Sp } from './sp-actions.ts'
import type { Trove } from './trove-actions.ts'
import type { Outcome, Ve } from './ve-actions.ts'

export interface McpOptions {
  lens: Lens
  /** Present only when the operator configured a wallet and valid limits. Without it, pay_and_fetch explains why it is off. */
  buyer?: Buyer
  payOffReason?: string
  /** The LIVE vote-escrow tools. Without it, ve_status and gauge_rewards are not offered; its `write` part exists only when the operator enabled writes. */
  ve?: Ve
  /** The trove planners and trove_status. Without it they are not offered; its `write` part exists only when the operator enabled writes. */
  trove?: Trove
  /** sp_status, allowance_status and plan_sp_deposit. Without it they are not offered; its `write` part exists only when the operator enabled writes. */
  sp?: Sp
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
const PLAN_NOTE = 'Reads Mezo testnet (the trove contracts, the sorted list and the MezoLens redemption walk), free and with no key; nothing is sent. Amounts are decimal strings; `raw` holds the exact integers (18 decimals). A plan that breaks a rule comes back as data with `refused: true` and the reason. Every answer names the block it was read at.'
// Every write is a real testnet transaction through the guarded writer; hosts that honour these hints should ask the user first.
const sends = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
const SP_NOTE = 'Reads Mezo testnet (the Stability Pool, the sorted trove list, the price feed and token allowances), free and with no key; nothing is sent. Amounts are decimal strings; `raw` holds the exact integers (18 decimals). Every answer names the block it was read at.'
const WRITE_NOTE = 'Sends a real Mezo testnet transaction through the guarded writer: the operator\'s allow-list, spend caps and kill file apply, and every send is recorded. A refusal means nothing was sent.'

export function createMcpServer({ lens, buyer, payOffReason, ve, trove, sp }: McpOptions): McpServer {
  const server = new McpServer(
    { name: 'mezo-agent-toolkit', version: pkg.version },
    {
      instructions:
        `Mezo testnet only. ${4 + (ve ? 2 : 0) + (trove ? 4 : 0) + (sp ? 3 : 0)} free read tools (MUSD troves, the redemption queue, DEX quotes, veBTC and veMEZO locks${ve ? ', the LIVE vote-escrow status, gauge rewards' : ''}${trove ? ', trove plans and status' : ''}${sp ? ', the Stability Pool, a deposit plan and token allowances' : ''}) and pay_and_fetch, which buys data from x402 endpoints in MUSD under spend limits set by the operator.` +
        (ve?.write ? ' Six more tools (ve_approve_btc, ve_lock, ve_vote, ve_poke, ve_claim_rewards, ve_claim_rebase) send real testnet transactions through a guarded writer, under allow-list and caps the operator set.' : '') +
        (trove?.write ? ' Three more (trove_open, trove_add_coll, trove_repay) open a MUSD trove, add collateral and repay on the same guarded writer; they plan first and refuse what plan_open, plan_top_up or plan_repay would refuse, so read those first.' : '') +
        (sp?.write ? ' Five more (sp_approve_musd, sp_deposit, sp_withdraw, trove_liquidate, approve_revoke) approve and deposit MUSD to the Stability Pool, take it out, liquidate a trove under the 110% minimum and revoke an allowance on the same guarded writer; they read first and refuse what would revert, with the reason (sp_status says whether a withdrawal is blocked).' : ''),
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

  if (trove) {
    const w = trove.write
    const btc = (what: string) => z.string().describe(`${what} as a plain decimal in BTC, for example "0.045"`)
    const musd = (what: string) => z.string().describe(`${what} as a plain decimal in MUSD, for example "1900"`)
    server.registerTool(
      'plan_open',
      {
        title: 'Plan opening a MUSD trove',
        description: `Plan opening a MUSD trove (a collateralised loan) for one wallet: checks the minimum net debt, the 110% minimum ratio, the Recovery Mode rules and the wallet's BTC, then returns the exact calldata with the sorted-list hints, the ratio after, the distance to liquidation, the system ratio, the borrow cap and the redemption position (the redeemable MUSD ahead of it, and how that is counted). debtMusd is what the wallet receives: the 0.1% fee and the 200 MUSD gas reserve are added to the debt. ${PLAN_NOTE}`,
        inputSchema: { ...addressShape('Wallet that would open the trove'), collateralBtc: btc('BTC to deposit as collateral'), debtMusd: musd('MUSD to borrow') },
        annotations: readOnly,
      },
      (a) => read(() => trove.open({ address: a.address, collateralBtc: a.collateralBtc, debtMusd: a.debtMusd })),
    )
    server.registerTool(
      'plan_top_up',
      {
        title: 'Plan adding collateral to a trove',
        description: `Plan adding BTC collateral to one wallet's open trove: the ratio before and after, the hints, the redemption position after the move and the checks outside and inside Recovery Mode (outside it even a pure top-up must leave the trove at 110% or more). ${PLAN_NOTE}`,
        inputSchema: { ...addressShape('Owner of the trove'), amountBtc: btc('BTC to add') },
        annotations: readOnly,
      },
      (a) => read(() => trove.topUp({ address: a.address, amountBtc: a.amountBtc })),
    )
    server.registerTool(
      'plan_repay',
      {
        title: 'Plan repaying MUSD debt of a trove',
        description: `Plan repaying MUSD debt of one wallet's open trove: the debt and ratio before and after, the wallet's MUSD, the minimum net debt (what is left after the 200 MUSD gas reserve must stay above it), the hints and the redemption position after the move. Interest is paid first. ${PLAN_NOTE}`,
        inputSchema: { ...addressShape('Owner of the trove'), amountMusd: musd('MUSD to repay') },
        annotations: readOnly,
      },
      (a) => read(() => trove.repay({ address: a.address, amountMusd: a.amountMusd })),
    )
    server.registerTool(
      'trove_status',
      {
        title: 'MUSD trove status with queue position',
        description: `One trove, for any address, with the numbers the plans use: collateral, principal, interest and debt, the collateral ratio and its distance to the 110% minimum, the system ratio and whether Recovery Mode is on, the stored borrow cap, and the redemption position (the redeemable MUSD ahead of the trove). ${PLAN_NOTE}`,
        inputSchema: addressShape('Owner of the trove'),
        annotations: readOnly,
      },
      (a) => read(() => trove.status({ address: a.address })),
    )
    if (w) {
      server.registerTool(
        'trove_open',
        {
          title: 'Open a MUSD trove (risky)',
          description: `Open a MUSD trove for the operator's wallet: deposit BTC as collateral and borrow MUSD. It plans first with the sorted-list hints and refuses what plan_open would refuse (call plan_open and read its warnings first). Risky: the collateral stays in the trove and can be liquidated or redeemed against, so the operator must have set MEZO_WRITE_RISKY=1. The wallet can have one trove at a time. ${WRITE_NOTE}`,
          inputSchema: { collateralBtc: btc('BTC to deposit as collateral'), debtMusd: musd('MUSD to borrow (the fee and the gas reserve come on top)') },
          annotations: sends,
        },
        (a) => write(() => w.open({ collateralBtc: a.collateralBtc, debtMusd: a.debtMusd })),
      )
      server.registerTool(
        'trove_add_coll',
        {
          title: 'Add collateral to the trove',
          description: `Add BTC collateral to the operator's open trove, which raises its collateral ratio. It plans first and refuses what plan_top_up would refuse. ${WRITE_NOTE}`,
          inputSchema: { amountBtc: btc('BTC to add') },
          annotations: sends,
        },
        (a) => write(() => w.addColl({ amountBtc: a.amountBtc })),
      )
      server.registerTool(
        'trove_repay',
        {
          title: 'Repay MUSD debt of the trove',
          description: `Repay MUSD debt of the operator's open trove from the wallet's MUSD (no approval needed: the MUSD is burned). Interest is paid first. It plans first and refuses what plan_repay would refuse, including a repayment that leaves less than the minimum net debt. ${WRITE_NOTE}`,
          inputSchema: { amountMusd: musd('MUSD to repay') },
          annotations: sends,
        },
        (a) => write(() => w.repay({ amountMusd: a.amountMusd })),
      )
    }
  }

  if (sp) {
    const w = sp.write
    const musd = (what: string) => z.string().describe(`${what} as a plain decimal in MUSD, for example "10"`)
    server.registerTool(
      'sp_status',
      {
        title: 'Stability Pool status and withdraw check',
        description: `One depositor's position in the Stability Pool (the MUSD pool that absorbs liquidations and earns the liquidated BTC): the deposit after liquidation losses, the MUSD lost, the pending BTC gain and the pool totals. It also says whether a withdrawal is blocked right now: the pool refuses every non-zero withdrawal while a trove is under the 110% minimum ratio. The answer gives the lowest ratio found, which trove it is, how it was found, and the troves under 110% (the ones trove_liquidate can liquidate). ${SP_NOTE}`,
        inputSchema: addressShape('Depositor'),
        annotations: readOnly,
      },
      (a) => read(() => sp.status({ address: a.address })),
    )
    server.registerTool(
      'allowance_status',
      {
        title: 'Token allowances a wallet has given',
        description: `The BTC and MUSD allowances one wallet has given to the Stability Pool, BorrowerOperations, veBTC, veMEZO, permit2, the x402 proxy, the pool router, the old veBTC and one more spender you name. Only non-zero allowances are listed, with the exact amount, and the answer says what was checked. Use it before approve_revoke. ${SP_NOTE}`,
        inputSchema: { ...addressShape('Wallet that gave the allowances'), spender: z.string().optional().describe('One more spender to check (0x address)') },
        annotations: readOnly,
      },
      (a) => read(() => sp.allowances({ address: a.address, ...(a.spender === undefined ? {} : { spender: a.spender }) })),
    )
    server.registerTool(
      'plan_sp_deposit',
      {
        title: 'Plan a Stability Pool deposit',
        description: `Plans depositing MUSD into the Stability Pool before anything is sent: the exact provideToSP call (to, data, value 0) and a gas estimate, whether the pool first needs an exact MUSD approve (with its calldata), the deposit before and after, and whether a withdrawal is blocked right now (the pool refuses every non-zero withdrawal while a trove is under the 110% minimum, so MUSD put in now can stay locked). A deposit also pays out the wallet's pending BTC gain. A plan is refused only when the wallet holds less MUSD than the amount. Nothing is signed or sent; the paid hosted route POST /plan/sp-deposit gives the same answer. ${SP_NOTE}`,
        inputSchema: { ...addressShape('Wallet that would deposit'), amount: musd('MUSD to deposit') },
        annotations: readOnly,
      },
      (a) => read(() => sp.planDeposit({ address: a.address, amount: a.amount })),
    )
    if (w) {
      server.registerTool(
        'sp_approve_musd',
        {
          title: 'Approve MUSD for the Stability Pool',
          description: `Let the Stability Pool pull exactly this much MUSD from the operator's wallet; the deposit uses it up. Never unlimited. Refused when the allowance already equals the amount. Call it before sp_deposit. ${WRITE_NOTE}`,
          inputSchema: { amount: musd('MUSD to allow') },
          annotations: sends,
        },
        (a) => write(() => w.approveMusd({ amount: a.amount })),
      )
      server.registerTool(
        'sp_deposit',
        {
          title: 'Deposit MUSD into the Stability Pool',
          description: `Deposit MUSD from the operator's wallet into the Stability Pool; it also pays out any pending BTC gain. It reads first and refuses when the allowance (see sp_approve_musd) or the balance is too small. The deposit can lose value when it absorbs a liquidation, and a withdrawal can be blocked (see sp_status). ${WRITE_NOTE}`,
          inputSchema: { amount: musd('MUSD to deposit') },
          annotations: sends,
        },
        (a) => write(() => w.deposit({ amount: a.amount })),
      )
      server.registerTool(
        'sp_withdraw',
        {
          title: 'Withdraw MUSD from the Stability Pool',
          description: `Withdraw MUSD from the operator's Stability Pool deposit. It refuses, with the lowest ratio found and the simulation's own revert text, while the pool is blocked by a trove under the 110% minimum (check sp_status), and when the amount is above the deposit. ${WRITE_NOTE}`,
          inputSchema: { amount: musd('MUSD to withdraw') },
          annotations: sends,
        },
        (a) => write(() => w.withdraw({ amount: a.amount })),
      )
      server.registerTool(
        'trove_liquidate',
        {
          title: 'Liquidate a trove under 110% (risky)',
          description: `Liquidate one other wallet's trove with the protocol's own liquidate call: the trove's debt is paid from the Stability Pool and the caller gets the gas compensation (200 MUSD and 0.5% of the collateral). It refuses unless the trove is active and under the 110% minimum ratio at the block it reads (sp_status lists candidates). Risky: it acts on someone else's position, so the operator must have set MEZO_WRITE_RISKY=1. ${WRITE_NOTE}`,
          inputSchema: { borrower: z.string().describe('Owner of the trove to liquidate (0x address)') },
          annotations: sends,
        },
        (a) => write(() => w.liquidate({ borrower: a.borrower })),
      )
      server.registerTool(
        'approve_revoke',
        {
          title: 'Revoke a token allowance',
          description: `Set an allowance the operator's wallet gave on BTC or MUSD back to 0 (check allowance_status first). Refused when the allowance is already 0. ${WRITE_NOTE}`,
          inputSchema: { token: z.enum(['BTC', 'MUSD']).describe('BTC or MUSD'), spender: z.string().describe('Spender whose allowance to remove (0x address)') },
          annotations: sends,
        },
        (a) => write(() => w.revoke({ token: a.token, spender: a.spender })),
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
        `HTTP GET (default) or POST a URL. If the server asks for payment with x402, pay it in MUSD on Mezo testnet and return the data; the buyer needs no BTC for gas. ${limits} ` +
        'Only MUSD on Mezo testnet can be paid. A refusal means nothing was paid. If the answer says a payment may still have been charged, check the balance before paying again; that URL is not paid for again, with any body, until the chain shows the payment can no longer land. ' +
        'Paid Mezo reads of this toolkit: GET /v1/trove/{address}, /v1/redemption/{address}, /v1/ve/{address} and /v1/pool/quote?tokenIn=&tokenOut=&amountIn= on the server that runs `npm run serve`. ' +
        'Paid plans (unsigned calldata, nothing is sent): method POST with a JSON body to /plan/open, /plan/top-up, /plan/repay or /plan/sp-deposit on the Worker, for the plan price.',
      inputSchema: {
        url: z.string().max(2000).describe('Full http:// or https:// address'),
        method: z.enum(['GET', 'POST']).optional().describe('GET (default) or POST. POST sends the body and needs it; GET refuses one'),
        body: z.record(z.string(), z.unknown()).optional().describe('The JSON object to POST (for example {"address":"0x...","amountBtc":"0.001"}); only with method POST'),
      },
      // Spending is a side effect that cannot be undone, so hosts that honour these hints should ask the user first.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, method, body }) => {
      if (!buyer) {
        const reason = payOffReason ?? 'no wallet is configured'
        return fail(`pay_and_fetch is switched off: ${reason}. The read tools still work.`, { refused: true, reason })
      }
      try {
        if ((method === 'POST') !== (body !== undefined)) throw new PaymentRefused(method === 'POST' ? 'method POST needs a body, the JSON object to send' : 'a body is sent only with method POST')
        const r = await buyer.fetchPaid(url, body)
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
