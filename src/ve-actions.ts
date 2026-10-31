// The LIVE vote-escrow tools (veBTC, poolsVoter, RewardsDistributor): two readers and six guarded writers.
// A writer here reads the chain, refuses a call that would revert anyway, builds the calldata and hands it to the guarded write core
// (write.ts: allow-list, caps, kill file, simulation). What it reads back after a send is best effort: it never turns a mined tx into an error.
import { encodeFunctionData, isAddressEqual, pad, toEventSelector, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import { depositorAbi, erc20Abi, poolNameAbi, poolsVoterAbi, rewardAbi, rewardsDistributorAbi, veBtcAbi } from './abis.ts'
import { ADDRESSES, CHAIN_ID, LEGACY_VE, txUrl } from './config.ts'
import { InputError, parseAddress, parseTokenAmount, parseTokenId } from './inputs.ts'
import { fixed, isoTime, withRetry, type ReadClient } from './lens.ts'
import { MAX_LOCK_SECONDS, MAX_POOLS_PER_CALL } from './policy.ts'
import type { Status } from './receipts.ts'
import type { createWriter } from './write.ts'

const WEEK = 604_800n
const HOUR = 3_600n
const DAY = 86_400n
const MAX_LOCK_DAYS = Number(MAX_LOCK_SECONDS / DAY)
const MAX_WEIGHT = 10_000 // a vote weight is relative (60 and 40 split 60/40); the cap only keeps the numbers small
const MAX_POOLS_READ = 64 // pools read per call (the live voter has 17)
const MAX_REWARD_TOKENS = 16 // reward tokens read per fee or bribe contract
const MAX_CLAIM_CONTRACTS = 60 // what the allow-list entry accepts in one claim
const CONCURRENCY = 6
const NEVER = 2n ** 255n // ranking key of a pool that books fees but has no votes

const { veBTC, poolsVoter, rewardsDistributor, musd, btc } = ADDRESSES
const isZero = (a: Address) => isAddressEqual(a, zeroAddress)

// ---- the epoch -----------------------------------------------------------------------------------------------------------------------------

/** The voter's epoch (Thursday 00:00Z to Thursday 00:00Z). A local copy of ProtocolTimeLibrary; test/ve.test.ts pins it to values read from the live contract. */
export function epochAt(ts: bigint) {
  const start = ts - (ts % WEEK)
  const next = start + WEEK
  return { start, next, voteOpens: start + HOUR, voteCloses: next - HOUR }
}
export type Phase = 'opening-hour' | 'voting' | 'closing-hour'
/** poolsVoter rejects a vote at or before voteOpens, and after voteCloses unless the NFT is whitelisted. */
export function phaseAt(ts: bigint): Phase {
  const e = epochAt(ts)
  return ts <= e.voteOpens ? 'opening-hour' : ts > e.voteCloses ? 'closing-hour' : 'voting'
}

// ---- shapes --------------------------------------------------------------------------------------------------------------------------------

type Writer = Pick<ReturnType<typeof createWriter>, 'address' | 'offReason' | 'send'>
export type Refused = { sent: false; reason: string }
export type Sent = { sent: true; hash: Hex; status: Status; explorer: string; blockNumber: string | null; gasUsed: string | null; note?: string } & Record<string, unknown>
export type Outcome = Refused | Sent

export interface VeWrite {
  approveBtc(input: { amount: string }): Promise<Outcome>
  lock(input: { amount: string; days: number }): Promise<Outcome>
  vote(input: { tokenId: string; pools: { pool: string; weight: number }[] }): Promise<Outcome>
  poke(input: { tokenId: string }): Promise<Outcome>
  claimRewards(input: { tokenId: string }): Promise<Outcome>
  claimRebase(input: { tokenId: string }): Promise<Outcome>
}
export interface Ve {
  status(input?: { tokenId?: string }): Promise<Record<string, unknown>>
  rewards(input?: { tokenId?: string }): Promise<Record<string, unknown>>
  /** Present only when the operator turned writes on (MEZO_WRITE_ENABLE=testnet); each method still refuses with the writer's reason if its setup is bad. */
  write?: VeWrite
}

interface Pinned {
  block: bigint
  ts: bigint
  meta: { blockNumber: number; blockTime: string; chainId: number }
  read<T>(address: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<T>
  tryRead<T>(address: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<T | undefined>
}

interface PoolRow {
  index: number
  pool: Address
  name: string | null
  gauge: Address
  alive: boolean
  weight: bigint
  fees: Address
  bribe: Address
  booked: bigint
  prev: bigint
}
interface Claim {
  kind: 'fee' | 'bribe'
  pool: Address
  reward: Address
  token: Address
  amount: bigint
}
interface Plan {
  to: Address
  data: Hex
  after?: (receipt: Receipt | undefined) => Promise<Record<string, unknown>>
}
type Receipt = Awaited<ReturnType<PublicClient['getTransactionReceipt']>>

const messageOf = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
const no = (reason: string): Refused => ({ sent: false, reason })

/** Run `fn` over `items` with at most `limit` in flight, keeping the order of the results. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!, i)
      }
    }),
  )
  return out
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
/** The id of the NFT a createLock receipt minted to `to` (the veBTC Transfer log from the zero address; an ERC-20 Transfer has 3 topics, not 4). */
function mintedTokenId(logs: Receipt['logs'], to: Address): bigint | undefined {
  const from = pad(zeroAddress, { size: 32 })
  const dest = pad(to, { size: 32 }).toLowerCase()
  const log = logs.find((l) => isAddressEqual(l.address, veBTC) && l.topics.length === 4 && l.topics[0] === TRANSFER && l.topics[1] === from && l.topics[2]?.toLowerCase() === dest)
  return log ? BigInt(log.topics[3]!) : undefined
}

// ---- the tools -----------------------------------------------------------------------------------------------------------------------------

export interface VeOptions {
  /** How long a read-back after a send keeps asking when the node that answers has not got the receipt or the block yet (default 15000). */
  patienceMs?: number
  /** The pause between those asks (default 500). */
  retryMs?: number
}

export function createVe(client: PublicClient, writer?: Writer, options: VeOptions = {}): Ve {
  const rc: ReadClient = client
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

  /** Pin every read of one call to one block, so the numbers in an answer agree with each other. */
  async function pin(at?: bigint): Promise<Pinned> {
    // `at` is the block of our own receipt: the node that answers may not have it yet, so a read-back waits for it instead of showing the state before the send.
    const ask: <T>(fn: () => Promise<T>) => Promise<T> = at === undefined ? (fn) => withRetry(fn) : patiently
    const block = at ?? (await withRetry(() => rc.getBlockNumber()))
    const ts = (await ask(() => rc.getBlock({ blockNumber: block }))).timestamp
    const read = <T>(address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) =>
      ask(() => rc.readContract({ address, abi, functionName: fn, args, blockNumber: block }) as Promise<T>)
    return {
      block,
      ts,
      meta: { blockNumber: Number(block), blockTime: isoTime(ts), chainId: CHAIN_ID },
      read,
      tryRead: <T>(address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => read<T>(address, abi, fn, args).then((v) => v, () => undefined),
    }
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------------------------

  async function census(p: Pinned, epochStart: bigint): Promise<{ rows: PoolRow[]; total: number }> {
    const total = Number(await p.read<bigint>(poolsVoter, poolsVoterAbi, 'length'))
    const rows = await mapLimit(Array.from({ length: Math.min(total, MAX_POOLS_READ) }, (_, i) => i), CONCURRENCY, async (index): Promise<PoolRow> => {
      const pool = await p.read<Address>(poolsVoter, poolsVoterAbi, 'pools', [BigInt(index)])
      const gauge = await p.read<Address>(poolsVoter, poolsVoterAbi, 'gauges', [pool])
      if (isZero(gauge)) return { index, pool, name: null, gauge, alive: false, weight: 0n, fees: zeroAddress, bribe: zeroAddress, booked: 0n, prev: 0n }
      const [alive, weight, fees, bribe, name] = await Promise.all([
        p.read<boolean>(poolsVoter, poolsVoterAbi, 'isAlive', [gauge]),
        p.read<bigint>(poolsVoter, poolsVoterAbi, 'weights', [pool]),
        p.read<Address>(poolsVoter, poolsVoterAbi, 'gaugeToFees', [gauge]), // keyed by the gauge, not the pool
        p.read<Address>(poolsVoter, poolsVoterAbi, 'gaugeToBribe', [gauge]),
        p.tryRead<string>(pool, poolNameAbi, 'name'), // some pools have no name()
      ])
      const booked = (at: bigint) => (isZero(fees) ? Promise.resolve(0n) : p.read<bigint>(fees, rewardAbi, 'tokenRewardsPerEpoch', [musd, at]))
      const [thisEpoch, lastEpoch] = await Promise.all([booked(epochStart), booked(epochStart - WEEK)])
      return { index, pool, name: name ?? null, gauge, alive, weight, fees, bribe, booked: thisEpoch, prev: lastEpoch }
    })
    return { rows, total }
  }

  /** Every non-zero `earned` for one NFT across the fee and bribe contracts of all gauges (read from the chain, never from the caller). */
  async function claimables(p: Pinned, id: bigint, rows: PoolRow[]): Promise<{ items: Claim[]; unreadable: number }> {
    const units = rows.flatMap((r) => [{ kind: 'fee' as const, pool: r.pool, reward: r.fees }, { kind: 'bribe' as const, pool: r.pool, reward: r.bribe }]).filter((u) => !isZero(u.reward))
    let unreadable = 0
    const found = await mapLimit(units, CONCURRENCY, async ({ kind, pool, reward }) => {
      const out: Claim[] = []
      const n = await p.tryRead<bigint>(reward, rewardAbi, 'rewardsListLength')
      if (n === undefined) {
        unreadable++
        return out
      }
      for (let i = 0n; i < n && i < BigInt(MAX_REWARD_TOKENS); i++) {
        const token = await p.tryRead<Address>(reward, rewardAbi, 'rewards', [i])
        const amount = token === undefined ? undefined : await p.tryRead<bigint>(reward, rewardAbi, 'earned', [token, id])
        if (token === undefined || amount === undefined) unreadable++
        else if (amount > 0n) out.push({ kind, pool, reward, token, amount })
      }
      return out
    })
    return { items: found.flat(), unreadable }
  }

  async function status(input: { tokenId?: string } = {}) {
    const id = input.tokenId === undefined ? undefined : parseTokenId(input.tokenId)
    const p = await pin()
    const e = epochAt(p.ts)
    const phase = phaseAt(p.ts)
    const system = async (label: 'LIVE' | 'LEGACY', ve: Address, voter: Address, rd: Address) => {
      const depositor = await p.read<Address>(rd, rewardsDistributorAbi, 'depositor')
      const active = await p.read<bigint>(depositor, depositorAbi, 'activePeriod')
      const behind = e.start > active ? (e.start - active) / WEEK : 0n
      // The depositor rolls the epoch after it starts; one epoch behind is a pause, more means the system no longer distributes.
      return { label, veBTC: ve, voter, rewardsDistributor: rd, depositor, activePeriod: isoTime(active), epochsBehind: Number(behind), distributing: behind <= 1n }
    }
    const [live, legacy, pools, totalWeight, maxVotingNum] = await Promise.all([
      system('LIVE', veBTC, poolsVoter, rewardsDistributor),
      system('LEGACY', LEGACY_VE.veBTC, LEGACY_VE.voter, LEGACY_VE.rewardsDistributor),
      p.read<bigint>(poolsVoter, poolsVoterAbi, 'length'),
      p.read<bigint>(poolsVoter, poolsVoterAbi, 'totalWeight'),
      p.read<bigint>(poolsVoter, poolsVoterAbi, 'maxVotingNum'),
    ])
    const nft = id === undefined ? undefined : await nftStatus(p, id, phase)
    const sys = (s: typeof live) => (s.distributing ? `${s.label} distributes (rolled ${s.activePeriod})` : `${s.label} is stalled since ${s.activePeriod} (${s.epochsBehind} epochs behind)`)
    const summary = [
      `${sys(live)}; ${sys(legacy)}.`,
      `Epoch ${isoTime(e.start)} to ${isoTime(e.next)}, phase ${phase}: votes are accepted after ${isoTime(e.voteOpens)} and up to ${isoTime(e.voteCloses)}.`,
      live.distributing ? undefined : 'WARNING: the system configured as LIVE is not distributing.',
      nft && 'canVoteNow' in nft ? `NFT ${id}: ${nft.canVoteNow ? 'can vote now' : `cannot vote now (${(nft.why as string[]).join('; ')})`}.` : undefined,
    ].filter(Boolean).join(' ')
    return {
      ...p.meta,
      systems: { live, legacy },
      epoch: { start: isoTime(e.start), next: isoTime(e.next), voteOpens: isoTime(e.voteOpens), voteCloses: isoTime(e.voteCloses), phase, secondsToNext: Number(e.next - p.ts), canVoteNow: phase === 'voting' },
      voter: { address: poolsVoter, pools: Number(pools), totalWeight: fixed(totalWeight, 18, 6), maxVotingNum: Number(maxVotingNum), raw: { totalWeight: totalWeight.toString() } },
      ...(nft ? { nft } : {}),
      summary,
    }
  }

  async function nftStatus(p: Pinned, id: bigint, phase: Phase) {
    const e = epochAt(p.ts)
    const owner = await p.tryRead<Address>(veBTC, veBtcAbi, 'ownerOf', [id])
    if (owner === undefined || isZero(owner)) {
      const old = await p.tryRead<Address>(LEGACY_VE.veBTC, veBtcAbi, 'ownerOf', [id])
      if (old !== undefined && !isZero(old)) return { tokenId: id.toString(), exists: true, system: 'LEGACY', owner: old, note: 'This NFT is on the LEGACY veBTC, whose distributor stopped: votes and claims there pay nothing, and these tools do not touch it.' }
      return { tokenId: id.toString(), exists: false, system: null, note: 'No veBTC NFT has this id on the LIVE or the LEGACY system.' }
    }
    const [lock, power, voted, lastVoted, used, whitelisted] = await Promise.all([
      p.read<{ amount: bigint; end: bigint; isPermanent: boolean }>(veBTC, veBtcAbi, 'locked', [id]),
      p.read<bigint>(veBTC, veBtcAbi, 'votingPowerOfNFT', [id]),
      p.read<boolean>(veBTC, veBtcAbi, 'voted', [id]),
      p.read<bigint>(poolsVoter, poolsVoterAbi, 'lastVoted', [id]),
      p.read<bigint>(poolsVoter, poolsVoterAbi, 'usedWeights', [id]),
      p.read<boolean>(poolsVoter, poolsVoterAbi, 'isWhitelistedNFT', [id]),
    ])
    const votedThisEpoch = lastVoted >= e.start
    const why: string[] = []
    if (phase === 'opening-hour') why.push(`the epoch's first hour is closed to votes until ${isoTime(e.voteOpens)}`)
    if (phase === 'closing-hour' && !whitelisted) why.push("the epoch's last hour is closed to votes (only whitelisted NFTs may vote)")
    if (votedThisEpoch) why.push(`it already voted in this epoch (at ${isoTime(lastVoted)}); the next vote opens after ${isoTime(e.next + HOUR)}`)
    if (power === 0n) why.push('its voting power is 0 (the lock expired, or the NFT arrived in this very block)')
    return {
      tokenId: id.toString(),
      exists: true,
      system: 'LIVE',
      owner,
      amount: fixed(lock.amount, 18, 8),
      unlocksAt: lock.isPermanent ? null : isoTime(lock.end),
      isPermanent: lock.isPermanent,
      votingPower: fixed(power, 18, 10),
      voted,
      lastVoted: lastVoted === 0n ? null : isoTime(lastVoted),
      votedThisEpoch,
      usedWeights: fixed(used, 18, 10),
      isWhitelisted: whitelisted,
      canVoteNow: why.length === 0,
      why,
      raw: { amount: lock.amount.toString(), end: lock.end.toString(), votingPower: power.toString(), lastVoted: lastVoted.toString(), usedWeights: used.toString() },
    }
  }

  async function rewards(input: { tokenId?: string } = {}) {
    const id = input.tokenId === undefined ? undefined : parseTokenId(input.tokenId)
    const p = await pin()
    const e = epochAt(p.ts)
    const { rows, total } = await census(p, e.start)
    const mine = id === undefined ? undefined : await mapLimit(rows, CONCURRENCY, (r) => p.read<bigint>(poolsVoter, poolsVoterAbi, 'votes', [id, r.pool]))
    const claim = id === undefined ? undefined : await claimables(p, id, rows)
    // Fees booked this epoch per unit of vote weight now on the pool (votes persist, so the weight is what the pool holds today).
    const key = (r: PoolRow) => (r.weight === 0n ? (r.booked > 0n ? NEVER : 0n) : (r.booked * 10n ** 18n) / r.weight)
    const order = [...rows.filter((r) => r.alive).sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : a.index - b.index)), ...rows.filter((r) => !r.alive)]
    const pools = order.map((r) => ({
      rank: r.alive ? order.indexOf(r) + 1 : null,
      index: r.index,
      pool: r.pool,
      name: r.name,
      gauge: r.gauge,
      votable: r.alive,
      weight: fixed(r.weight, 18, 6),
      musdFeesBooked: fixed(r.booked, 18, 4),
      musdFeesBookedLastEpoch: fixed(r.prev, 18, 4),
      musdPerUnitWeight: r.weight === 0n ? null : fixed(key(r), 18, 6),
      ...(r.weight === 0n ? { noVotes: true } : {}),
      feeContract: r.fees,
      bribeContract: r.bribe,
      ...(mine ? { yourVote: fixed(mine[rows.indexOf(r)]!, 18, 10) } : {}),
    }))
    const tokens = new Map<Address, { symbol: string; decimals: number }>()
    for (const t of new Set((claim?.items ?? []).map((c) => c.token))) {
      const [symbol, decimals] = await Promise.all([p.tryRead<string>(t, erc20Abi, 'symbol'), p.tryRead<number>(t, erc20Abi, 'decimals')])
      tokens.set(t, { symbol: symbol ?? 'UNKNOWN', decimals: decimals ?? 18 })
    }
    const name = new Map(rows.map((r) => [r.pool, r.name]))
    const claimable = (claim?.items ?? []).map((c) => {
      const t = tokens.get(c.token)!
      return { kind: c.kind, pool: c.pool, poolName: name.get(c.pool) ?? null, rewardContract: c.reward, token: c.token, symbol: t.symbol, amount: fixed(c.amount, t.decimals, 8), raw: c.amount.toString() }
    })
    const top = pools.filter((x) => x.rank !== null && x.rank <= 3).map((x) => `${x.rank}. ${x.name ?? x.pool} (${x.musdPerUnitWeight ?? 'no votes'})`)
    return {
      ...p.meta,
      epoch: { start: isoTime(e.start), next: isoTime(e.next) },
      basis: 'Ranking = MUSD fees booked in the current epoch divided by the vote weight on the pool now (MUSD per 1.0 of weight). Fees booked in an epoch pay the voters of that epoch and can be claimed once it ends. Bribes are not in the ranking.',
      poolCount: total,
      pools,
      ...(id !== undefined ? { tokenId: id.toString(), claimable, ...(claim!.unreadable ? { unreadable: claim!.unreadable } : {}) } : {}),
      summary: `${pools.length} pools. Best MUSD fees per unit weight: ${top.join('; ') || 'none'}.${id !== undefined ? ` NFT ${id}: ${claimable.length} claimable reward${claimable.length === 1 ? '' : 's'}.` : ''}`,
    }
  }

  const read = { status, rewards }
  if (!writer) return read
  const w: Writer = writer

  // ---- writes --------------------------------------------------------------------------------------------------------------------------------

  /** Send through the write core, then read the receipt. Nothing after the send may throw: a mined tx must come back as a result. */
  async function submit(plan: Plan): Promise<Outcome> {
    let r: Awaited<ReturnType<Writer['send']>>
    try {
      r = await w.send({ to: plan.to, data: plan.data })
    } catch (e) {
      return no(`the write core failed (${messageOf(e)}); check the receipts file before trying again`)
    }
    if (!r.sent) return r
    // An unknown status means the write core already waited for a receipt in vain: ask once more, do not wait again.
    const getReceipt = () => client.getTransactionReceipt({ hash: r.hash })
    const receipt: Receipt | undefined = await (r.status === 'unknown' ? getReceipt() : patiently(getReceipt)).catch(() => undefined)
    const base: Sent = { sent: true, hash: r.hash, status: r.status, explorer: txUrl(r.hash), blockNumber: receipt ? receipt.blockNumber.toString() : null, gasUsed: receipt ? receipt.gasUsed.toString() : null, ...(r.note ? { note: r.note } : {}) }
    if (!plan.after || r.status !== 'success') return base
    // Without the receipt there is no block to pin the read-back to, and a read at "latest" can still be the state before the send (voted: false after a vote): show nothing instead.
    if (!receipt) return { ...base, readBack: 'the transaction succeeded, but the RPC did not return its receipt in time, so the new state is not shown; read it with ve_status in a few seconds' }
    try {
      return { ...base, ...(await plan.after(receipt)) }
    } catch (e) {
      return { ...base, readBack: `the transaction was mined, but reading the result back failed (${messageOf(e)})` }
    }
  }

  /** Check the writer is on, build the plan (chain read errors become a refusal; bad input stays an InputError), then submit. */
  async function run(build: (me: Address) => Promise<Refused | Plan>): Promise<Outcome> {
    const me = w.address
    if (w.offReason || !me) return no(w.offReason ?? 'writes are off')
    let plan: Refused | Plan
    try {
      plan = await build(me)
    } catch (e) {
      if (e instanceof InputError) throw e
      return no(`a chain read failed before anything was sent: ${messageOf(e)}`)
    }
    return 'sent' in plan ? plan : submit(plan)
  }

  /** A fresh pin for a read-back (the receipt's block when we have it). */
  const pinAfter = (receipt: Receipt | undefined) => pin(receipt?.blockNumber)

  const write: VeWrite = {
    approveBtc: ({ amount }) =>
      run(async (me) => {
        const value = parseTokenAmount(amount, 18, 'amount')
        const p = await pin()
        const current = await p.read<bigint>(btc, erc20Abi, 'allowance', [me, veBTC])
        if (current === value) return no(`veBTC already has an allowance of exactly ${amount} BTC from this wallet, so no approve was needed`)
        return {
          to: btc,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [veBTC, value] }),
          after: async (rcpt) => {
            const q = await pinAfter(rcpt)
            return { spender: veBTC, allowanceBefore: fixed(current, 18, 18), allowance: fixed(await q.read<bigint>(btc, erc20Abi, 'allowance', [me, veBTC]), 18, 18) }
          },
        }
      }),

    lock: ({ amount, days }) =>
      run(async (me) => {
        const value = parseTokenAmount(amount, 18, 'amount')
        if (!Number.isInteger(days) || days < 1 || days > MAX_LOCK_DAYS) throw new InputError(`days must be a whole number from 1 to ${MAX_LOCK_DAYS}`)
        const duration = BigInt(days) * DAY
        const p = await pin()
        const unlock = ((p.ts + duration) / WEEK) * WEEK // the contract rounds the end down to a Thursday
        if (unlock <= p.ts) return no(`a ${days}-day lock would end at ${isoTime(unlock)}, which is not in the future (the end is rounded down to a Thursday 00:00Z); use more days`)
        const [allowance, balance] = await Promise.all([p.read<bigint>(btc, erc20Abi, 'allowance', [me, veBTC]), p.read<bigint>(btc, erc20Abi, 'balanceOf', [me])])
        if (allowance < value) return no(`veBTC may pull only ${fixed(allowance, 18, 18)} BTC from this wallet; call ve_approve_btc for exactly ${amount} first`)
        if (balance < value) return no(`the wallet holds ${fixed(balance, 18, 8)} BTC, less than the ${amount} BTC to lock`)
        return {
          to: veBTC,
          data: encodeFunctionData({ abi: veBtcAbi, functionName: 'createLock', args: [value, duration] }),
          after: async (rcpt) => {
            const tokenId = rcpt ? mintedTokenId(rcpt.logs, me) : undefined
            if (tokenId === undefined) return { tokenId: null, readBack: 'the lock was mined but the new NFT id was not found in the receipt; list the wallet with ve_locks' }
            const q = await pinAfter(rcpt)
            const lock = await q.read<{ amount: bigint; end: bigint }>(veBTC, veBtcAbi, 'locked', [tokenId])
            return { tokenId: tokenId.toString(), amount: fixed(lock.amount, 18, 18), unlocksAt: isoTime(lock.end), nextStep: 'wait for the next block (voting power is 0 in the block the NFT arrives), then call ve_vote' }
          },
        }
      }),

    vote: ({ tokenId, pools }) =>
      run(async (me) => {
        const id = parseTokenId(tokenId)
        if (!Array.isArray(pools) || pools.length === 0) throw new InputError('pools must list at least one pool')
        if (pools.length > MAX_POOLS_PER_CALL) throw new InputError(`pools lists more than ${MAX_POOLS_PER_CALL} pools`)
        const list = pools.map((x, i) => {
          if (!Number.isInteger(x.weight) || x.weight < 1 || x.weight > MAX_WEIGHT) throw new InputError(`pools[${i}].weight must be a whole number from 1 to ${MAX_WEIGHT} (weights are relative)`)
          return { pool: parseAddress(x.pool, `pools[${i}].pool`), weight: x.weight }
        })
        if (new Set(list.map((x) => x.pool)).size !== list.length) throw new InputError('pools lists the same pool twice')
        const p = await pin()
        const e = epochAt(p.ts)
        const owner = await p.tryRead<Address>(veBTC, veBtcAbi, 'ownerOf', [id])
        if (owner === undefined || isZero(owner)) return no(`NFT ${id} does not exist on the LIVE veBTC (it may be on the LEGACY system; see ve_status)`)
        const [approved, lastVoted, power, whitelisted, maxNum] = await Promise.all([
          p.read<boolean>(veBTC, veBtcAbi, 'isApprovedOrOwner', [me, id]),
          p.read<bigint>(poolsVoter, poolsVoterAbi, 'lastVoted', [id]),
          p.read<bigint>(veBTC, veBtcAbi, 'votingPowerOfNFT', [id]),
          p.read<boolean>(poolsVoter, poolsVoterAbi, 'isWhitelistedNFT', [id]),
          p.read<bigint>(poolsVoter, poolsVoterAbi, 'maxVotingNum'),
        ])
        if (!approved) return no(`this wallet does not own NFT ${id} and is not approved for it`)
        if (p.ts <= e.voteOpens) return no(`votes are closed in the epoch's first hour; they open after ${isoTime(e.voteOpens)}`)
        if (p.ts > e.voteCloses && !whitelisted) return no(`votes are closed in the epoch's last hour; the next epoch opens to votes after ${isoTime(e.next + HOUR)}`)
        if (lastVoted >= e.start) return no(`NFT ${id} already voted in this epoch (at ${isoTime(lastVoted)}); it can vote again after ${isoTime(e.next + HOUR)}`)
        if (power === 0n) return no(`NFT ${id} has voting power 0 in this block (it is 0 in the block the NFT arrives, and after the lock expires); try again in the next block`)
        if (BigInt(list.length) > maxNum) return no(`the voter accepts at most ${maxNum} pools per vote`)
        for (const x of list) {
          const gauge = await p.read<Address>(poolsVoter, poolsVoterAbi, 'gauges', [x.pool])
          if (isZero(gauge)) return no(`${x.pool} is not a pool with a gauge on the LIVE voter (see gauge_rewards for the pools)`)
          if (!(await p.read<boolean>(poolsVoter, poolsVoterAbi, 'isAlive', [gauge]))) return no(`the gauge of ${x.pool} is not alive, so it takes no votes`)
        }
        return {
          to: poolsVoter,
          data: encodeFunctionData({ abi: poolsVoterAbi, functionName: 'vote', args: [id, list.map((x) => x.pool), list.map((x) => BigInt(x.weight))] }),
          after: async (rcpt) => {
            const q = await pinAfter(rcpt)
            const [voted, last, used, total] = await Promise.all([
              q.read<boolean>(veBTC, veBtcAbi, 'voted', [id]),
              q.read<bigint>(poolsVoter, poolsVoterAbi, 'lastVoted', [id]),
              q.read<bigint>(poolsVoter, poolsVoterAbi, 'usedWeights', [id]),
              q.read<bigint>(poolsVoter, poolsVoterAbi, 'totalWeight'),
            ])
            const rows = await mapLimit(list, CONCURRENCY, async (x) => {
              const [mine, weight] = await Promise.all([q.read<bigint>(poolsVoter, poolsVoterAbi, 'votes', [id, x.pool]), q.read<bigint>(poolsVoter, poolsVoterAbi, 'weights', [x.pool])])
              return { pool: x.pool, relativeWeight: x.weight, yourVotes: fixed(mine, 18, 10), poolWeight: fixed(weight, 18, 10), raw: { yourVotes: mine.toString(), poolWeight: weight.toString() } }
            })
            return { tokenId: id.toString(), voted, lastVoted: isoTime(last), usedWeights: fixed(used, 18, 10), totalWeight: fixed(total, 18, 10), pools: rows }
          },
        }
      }),

    poke: ({ tokenId }) =>
      run(async (me) => {
        const id = parseTokenId(tokenId)
        const p = await pin()
        const e = epochAt(p.ts)
        const owner = await p.tryRead<Address>(veBTC, veBtcAbi, 'ownerOf', [id])
        if (owner === undefined || isZero(owner) || !isAddressEqual(owner, me)) return no(`this wallet does not own NFT ${id} (poke is only sent for NFTs the wallet owns)`)
        if (p.ts <= e.voteOpens) return no(`poke is closed in the epoch's first hour; it opens after ${isoTime(e.voteOpens)}`)
        const [voted, power, used] = await Promise.all([
          p.read<boolean>(veBTC, veBtcAbi, 'voted', [id]),
          p.read<bigint>(veBTC, veBtcAbi, 'votingPowerOfNFT', [id]),
          p.read<bigint>(poolsVoter, poolsVoterAbi, 'usedWeights', [id]),
        ])
        if (!voted) return no(`NFT ${id} has no vote to refresh; use ve_vote`)
        // A poke re-votes the stored split at today's power. Power only falls as a lock runs down, so it would shrink the weights.
        if (power <= used) return no(`poke would not raise the weights of NFT ${id} (power ${fixed(power, 18, 10)} is not above the ${fixed(used, 18, 10)} already voted)`)
        return {
          to: poolsVoter,
          data: encodeFunctionData({ abi: poolsVoterAbi, functionName: 'poke', args: [id] }),
          after: async (rcpt) => ({ tokenId: id.toString(), usedWeights: fixed(await (await pinAfter(rcpt)).read<bigint>(poolsVoter, poolsVoterAbi, 'usedWeights', [id]), 18, 10) }),
        }
      }),

    claimRewards: ({ tokenId }) =>
      run(async (me) => {
        const id = parseTokenId(tokenId)
        const p = await pin()
        const owner = await p.tryRead<Address>(veBTC, veBtcAbi, 'ownerOf', [id])
        if (owner === undefined || isZero(owner) || !isAddressEqual(owner, me)) return no(`this wallet does not own NFT ${id} (claims are only sent for NFTs the wallet owns)`)
        const { rows } = await census(p, epochAt(p.ts).start)
        const { items } = await claimables(p, id, rows)
        if (items.length === 0) return no(`NFT ${id} has nothing to claim from any gauge now (fees booked in an epoch can be claimed after that epoch ends, on Thursday 00:00Z)`)
        // The reward contracts and tokens come from the chain, never from the caller.
        const byContract = new Map<Address, Address[]>()
        for (const c of items) byContract.set(c.reward, [...(byContract.get(c.reward) ?? []), c.token])
        const contracts = [...byContract.keys()].slice(0, MAX_CLAIM_CONTRACTS)
        return {
          to: poolsVoter,
          data: encodeFunctionData({ abi: poolsVoterAbi, functionName: 'claimFeesAndBribes', args: [contracts, contracts.map((c) => byContract.get(c)!), id] }),
          after: async (rcpt) => {
            const q = await pinAfter(rcpt)
            const left = await claimables(q, id, (await census(q, epochAt(q.ts).start)).rows)
            return { tokenId: id.toString(), expected: items.map((c) => ({ kind: c.kind, pool: c.pool, token: c.token, raw: c.amount.toString() })), stillClaimable: left.items.length }
          },
        }
      }),

    claimRebase: ({ tokenId }) =>
      run(async (me) => {
        const id = parseTokenId(tokenId)
        const p = await pin()
        const owner = await p.tryRead<Address>(veBTC, veBtcAbi, 'ownerOf', [id])
        if (owner === undefined || isZero(owner) || !isAddressEqual(owner, me)) return no(`this wallet does not own NFT ${id} (claims are only sent for NFTs the wallet owns)`)
        const claimable = await p.read<bigint>(rewardsDistributor, rewardsDistributorAbi, 'claimable', [id])
        if (claimable === 0n) return no(`the LIVE RewardsDistributor has no rebase to claim for NFT ${id} now`)
        return {
          to: rewardsDistributor,
          data: encodeFunctionData({ abi: rewardsDistributorAbi, functionName: 'claim', args: [id] }),
          after: async (rcpt) => ({ tokenId: id.toString(), expected: fixed(claimable, 18, 18), claimableAfter: fixed(await (await pinAfter(rcpt)).read<bigint>(rewardsDistributor, rewardsDistributorAbi, 'claimable', [id]), 18, 18) }),
        }
      }),
  }
  return { ...read, write }
}
