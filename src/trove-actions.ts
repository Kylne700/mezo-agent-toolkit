// The trove tools: four reads (plan_open, plan_top_up, plan_repay, trove_status) and, only when the operator turned writes on, three guarded writers
// (open a trove, add collateral, repay). A writer plans for the wallet's OWN address with plan.ts, refuses when the plan is refused, and otherwise hands
// the exact calldata, hints included, to the guarded write core (write.ts: allow-list, caps, kill file, simulation). What it reads back after a send is
// best effort: it never turns a mined tx into an error.
import type { Address, PublicClient } from 'viem'
import { txUrl } from './config.ts'
import { InputError } from './inputs.ts'
import { createPlanner, type PlanClient, type PlanLens, type PlanOk, type Planner, type Plan } from './plan.ts'
import type { Outcome, Refused, Sent, VeOptions } from './ve-actions.ts'
import type { createWriter } from './write.ts'

type Writer = Pick<ReturnType<typeof createWriter>, 'address' | 'offReason' | 'send'>

export interface TroveWrite {
  open(input: { collateralBtc: string; debtMusd: string }): Promise<Outcome>
  addColl(input: { amountBtc: string }): Promise<Outcome>
  repay(input: { amountMusd: string }): Promise<Outcome>
}
/** The planner (open, topUp, repay, status: all reads) plus, only when the operator enabled writes, the three writers. */
export interface Trove extends Planner {
  write?: TroveWrite
}

const messageOf = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
const no = (reason: string): Refused => ({ sent: false, reason })

export function createTrove(client: PublicClient, lens: PlanLens, writer?: Writer, options: VeOptions = {}): Trove {
  const planner = createPlanner(client, lens)
  if (!writer) return planner
  const w: Writer = writer
  const patienceMs = options.patienceMs ?? 15_000
  const retryMs = options.retryMs ?? 500

  /** The RPC is several nodes behind one URL and the one that answers can be a block behind: after our own send, ask again until it has the receipt and the block, or the patience is spent. */
  async function patiently<T>(fn: () => Promise<T>): Promise<T> {
    const until = Date.now() + patienceMs
    for (;;) {
      try {
        return await fn()
      } catch (e) {
        if (Date.now() >= until) throw e
        await new Promise((r) => setTimeout(r, retryMs))
      }
    }
  }
  // The read-back is pinned to the receipt's block, so every read of it waits for that block instead of showing the state before the send.
  const patientClient: PlanClient = { getBlockNumber: () => client.getBlockNumber(), getBlock: (a) => patiently(() => client.getBlock(a)), readContract: (a) => patiently(() => client.readContract(a)) }
  const patientLens: PlanLens = { redemptionRisk: (a, o) => patiently(() => lens.redemptionRisk(a, o)) }
  const readBack = createPlanner(patientClient, patientLens)

  /** Send through the write core, then read the receipt and the trove at its block. Nothing after the send may throw: a mined tx must come back as a result. */
  async function submit(plan: PlanOk): Promise<Outcome> {
    let r: Awaited<ReturnType<Writer['send']>>
    try {
      r = await w.send({ to: plan.to, data: plan.data, value: BigInt(plan.value) })
    } catch (e) {
      return no(`the write core failed (${messageOf(e)}); check the receipts file before trying again`)
    }
    if (!r.sent) return r
    // An unknown status means the write core already waited for a receipt in vain: ask once more, do not wait again.
    const getReceipt = () => client.getTransactionReceipt({ hash: r.hash })
    const receipt = await (r.status === 'unknown' ? getReceipt() : patiently(getReceipt)).catch(() => undefined)
    const base: Sent = { sent: true, hash: r.hash, status: r.status, explorer: txUrl(r.hash), blockNumber: receipt ? receipt.blockNumber.toString() : null, gasUsed: receipt ? receipt.gasUsed.toString() : null, ...(r.note ? { note: r.note } : {}) }
    if (r.status !== 'success') return base
    // Without the receipt there is no block to pin the read-back to, and a read at "latest" can still be the state before the send: show nothing instead.
    if (!receipt) return { ...base, readBack: 'the transaction succeeded, but the RPC did not return its receipt in time, so the new state is not shown; read it with trove_status in a few seconds' }
    try {
      const planned = { action: plan.action, planBlock: plan.blockNumber, icrBefore: plan.icrBefore, icrAfter: plan.icrAfter, hints: plan.hints, redemptionPosition: plan.redemptionPosition }
      return { ...base, planned, troveAfter: await readBack.status({ address: plan.borrower }, { blockNumber: receipt.blockNumber }) }
    } catch (e) {
      return { ...base, readBack: `the transaction was mined, but reading the result back failed (${messageOf(e)})` }
    }
  }

  /** Check the writer is on, plan for the wallet's own address (chain read errors become a refusal; bad input stays an InputError), then submit. */
  async function run(build: (me: Address) => Promise<Plan>): Promise<Outcome> {
    const me = w.address
    if (w.offReason || !me) return no(w.offReason ?? 'writes are off')
    let plan: Plan
    try {
      plan = await build(me)
    } catch (e) {
      if (e instanceof InputError) throw e
      return no(`a chain read failed before anything was sent: ${messageOf(e)}`)
    }
    return plan.refused ? no(plan.reason) : submit(plan)
  }

  const write: TroveWrite = {
    open: ({ collateralBtc, debtMusd }) => run((me) => planner.open({ address: me, collateralBtc, debtMusd })),
    addColl: ({ amountBtc }) => run((me) => planner.topUp({ address: me, amountBtc })),
    repay: ({ amountMusd }) => run((me) => planner.repay({ address: me, amountMusd })),
  }
  return { ...planner, write }
}
