// The LIVE vote-escrow tools against a fake chain (test/helpers/ve.ts): the two readers, the six writers and every refusal.
// No network and no real transaction: the key is a throwaway generated here. A refusal must stop before the write core simulates, estimates or sends.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import { erc20Abi, poolsVoterAbi, rewardsDistributorAbi, veBtcAbi } from '../src/abis.ts'
import { ADDRESSES, LEGACY_VE } from '../src/config.ts'
import { InputError } from '../src/inputs.ts'
import { createVe, epochAt, phaseAt, type Outcome, type VeOptions } from '../src/ve-actions.ts'
import { createWriter } from '../src/write.ts'
import { SAT, STRANGER, TOKEN_T, addr, bribeOf, btcTransferLog, earnKey, feeOf, gaugeOf, mintLog, nft, pool, veWorld, type FakeNft, type World } from './helpers/ve.ts'
import { u } from './helpers/write.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = mkdtempSync(join(tmpdir(), 'mezo-ve-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const key = generatePrivateKey()
const keyFile = join(root, 'throwaway.key')
writeFileSync(keyFile, key, { mode: 0o600 })
const me = privateKeyToAccount(key).address
const NOW = new Date(Number(SAT) * 1000)
const e = epochAt(SAT)
const CAPS = { MEZO_WRITE_MAX_BTC_PER_CALL: '0.01', MEZO_WRITE_MAX_BTC_PER_DAY: '0.02', MEZO_WRITE_RISKY: '1' }

/** A fake chain, a writer on the SHIPPED allow-list (a fresh receipts ledger and kill file per case) and the tools on top. */
function setup(env: Record<string, string | undefined> = {}, tweak: (w: World) => void = () => {}, patience: VeOptions = { patienceMs: 0 }) {
  const world = veWorld(me)
  tweak(world.w)
  const rpc = world.rpc()
  const dir = mkdtempSync(join(root, 'case-'))
  const receipts = join(dir, 'receipts.jsonl')
  const writer = createWriter({ env: { MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: keyFile, MEZO_WRITE_RECEIPTS_FILE: receipts, ...CAPS, ...env }, client: rpc.client, now: () => NOW, receiptTimeoutMs: 200 })
  const ve = createVe(rpc.client, writer, patience)
  const lines = (): Json[] => (existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { w: world.w, rpc, dir, ve, write: ve.write!, lines }
}
type Case = ReturnType<typeof setup>
const reason = async (p: Promise<Outcome>) => {
  const r = await p
  return r.sent ? 'sent' : r.reason
}
/** Nothing was simulated, gas-estimated or sent (the write core's three steps after the checks). */
const quiet = (rpc: Case['rpc']) => {
  expect(rpc.methods()).not.toContain('eth_sendRawTransaction')
  expect(rpc.methods()).not.toContain('eth_estimateGas')
  expect(rpc.calls.filter((c) => c.method === 'eth_call' && c.params[0]?.from)).toEqual([])
}
/** The tool refused on its own reads: the write core was never reached, so even eth_chainId was not asked. */
const beforeCore = (rpc: Case['rpc']) => {
  quiet(rpc)
  expect(rpc.methods()).not.toContain('eth_chainId')
}
const mine = (over: Partial<FakeNft> = {}) => (w: World) => void w.nfts.set(1900n, nft({ owner: me, ...over }))
const call = (w: Case['w'], i = 0) => w.sent[i]!

describe('epoch math', () => {
  it('matches the epoch the live voter reported on 2026-10-31 (it began Thursday 2026-10-29)', () => {
    expect(e).toEqual({ start: 1793232000n, next: 1793836800n, voteOpens: 1793235600n, voteCloses: 1793833200n })
    expect(new Date(Number(e.start) * 1000).toISOString()).toBe('2026-10-29T00:00:00.000Z')
    expect(new Date(Number(e.voteCloses) * 1000).toISOString()).toBe('2026-11-04T23:00:00.000Z')
  })

  it('phase flips exactly where poolsVoter does: closed up to and including voteOpens, open to and including voteCloses', () => {
    expect([e.start, e.voteOpens].map(phaseAt)).toEqual(['opening-hour', 'opening-hour'])
    expect([e.voteOpens + 1n, SAT, e.voteCloses].map(phaseAt)).toEqual(['voting', 'voting', 'voting'])
    expect([e.voteCloses + 1n, e.next - 1n].map(phaseAt)).toEqual(['closing-hour', 'closing-hour'])
    expect(phaseAt(e.next)).toBe('opening-hour') // the next epoch has begun
    expect(epochAt(e.next).start).toBe(e.next)
  })
})

describe('ve_status', () => {
  it('names the LIVE system as distributing and the LEGACY one as stalled, with the epoch window', async () => {
    const { ve, write } = setup()
    expect(write).toBeDefined()
    const s: Json = await ve.status()
    expect(s).toMatchObject({ blockNumber: 16482100, chainId: 31611, blockTime: '2026-10-31T09:16:29.000Z' })
    expect(s.systems.live).toMatchObject({ label: 'LIVE', veBTC: ADDRESSES.veBTC, voter: ADDRESSES.poolsVoter, rewardsDistributor: ADDRESSES.rewardsDistributor, activePeriod: '2026-10-29T00:00:00.000Z', epochsBehind: 0, distributing: true })
    expect(s.systems.legacy).toMatchObject({ label: 'LEGACY', veBTC: LEGACY_VE.veBTC, voter: LEGACY_VE.voter, activePeriod: '2025-11-13T00:00:00.000Z', epochsBehind: 50, distributing: false })
    expect(s.epoch).toEqual({ start: '2026-10-29T00:00:00.000Z', next: '2026-11-05T00:00:00.000Z', voteOpens: '2026-10-29T01:00:00.000Z', voteCloses: '2026-11-04T23:00:00.000Z', phase: 'voting', secondsToNext: 398611, canVoteNow: true })
    expect(s.voter).toMatchObject({ address: ADDRESSES.poolsVoter, pools: 4, totalWeight: '15.797778', maxVotingNum: 30 })
    expect(s.summary).toMatch(/LIVE distributes \(rolled 2026-10-29.*LEGACY is stalled since 2025-11-13.*50 epochs behind/)
    expect(s.summary).not.toMatch(/WARNING/)
    expect(s.nft).toBeUndefined()
  })

  it('a LIVE system one epoch behind is a pause, two behind earns a WARNING', async () => {
    const one: Json = await setup({}, (w) => (w.liveLag = 1n)).ve.status()
    expect(one.systems.live).toMatchObject({ epochsBehind: 1, distributing: true })
    expect(one.summary).not.toMatch(/WARNING/)
    const two: Json = await setup({}, (w) => (w.liveLag = 2n)).ve.status()
    expect(two.systems.live).toMatchObject({ epochsBehind: 2, distributing: false })
    expect(two.summary).toMatch(/LIVE is stalled.*WARNING: the system configured as LIVE is not distributing/)
  })

  it('the phase follows the block time: the first hour and the last hour are not open to votes', async () => {
    for (const [ts, phase, can] of [[e.start + 1800n, 'opening-hour', false], [SAT, 'voting', true], [e.voteCloses + 60n, 'closing-hour', false]] as const) {
      const s: Json = await setup({}, (w) => (w.ts = ts)).ve.status()
      expect(s.epoch).toMatchObject({ phase, canVoteNow: can })
    }
  })

  it('one NFT on LIVE: lock, power, vote flags and why it cannot vote (it already voted in this epoch)', async () => {
    const { ve, rpc } = setup({}, (w) => w.nfts.set(1727n, nft({ owner: STRANGER, amount: 107_370_359_322_384n, end: 1_795_651_200n, power: 98_333_797_892_866n, voted: true, lastVoted: e.start + 3667n, used: 98_333_797_892_866n })))
    const s: Json = await ve.status({ tokenId: ' 1727 ' })
    expect(s.nft).toMatchObject({
      tokenId: '1727', exists: true, system: 'LIVE', owner: STRANGER, amount: '0.00010737', unlocksAt: '2026-11-26T00:00:00.000Z', isPermanent: false, votingPower: '0.0000983337',
      voted: true, lastVoted: '2026-10-29T01:01:07.000Z', votedThisEpoch: true, usedWeights: '0.0000983337', isWhitelisted: false, canVoteNow: false,
      raw: { amount: '107370359322384', end: '1795651200', votingPower: '98333797892866', lastVoted: '1793235667', usedWeights: '98333797892866' },
    })
    expect(s.nft.why).toEqual([expect.stringMatching(/already voted in this epoch \(at 2026-10-29T01:01:07.000Z\); the next vote opens after 2026-11-05T01:00:00.000Z/)])
    expect(s.summary).toMatch(/NFT 1727: cannot vote now \(it already voted/)
    expect(rpc.methods()).not.toContain('eth_sendRawTransaction')
  })

  it('says why an NFT cannot vote in the first hour, in the last hour (unless whitelisted) and with power 0', async () => {
    const why = async (tweak: (w: World) => void, over: Partial<FakeNft> = {}) => ((await setup({}, (w) => (w.nfts.set(5n, nft({ owner: me, ...over })), tweak(w))).ve.status({ tokenId: '5' })) as Json).nft
    expect(await why((w) => (w.ts = e.start + 1800n))).toMatchObject({ canVoteNow: false, why: [expect.stringMatching(/first hour is closed to votes until 2026-10-29T01:00:00.000Z/)] })
    expect(await why((w) => (w.ts = e.voteCloses + 60n))).toMatchObject({ canVoteNow: false, why: [expect.stringMatching(/last hour is closed to votes \(only whitelisted NFTs may vote\)/)] })
    expect(await why((w) => (w.ts = e.voteCloses + 60n), { whitelisted: true })).toMatchObject({ canVoteNow: true, isWhitelisted: true, why: [] })
    expect(await why(() => {}, { power: 0n })).toMatchObject({ canVoteNow: false, votingPower: '0', why: [expect.stringMatching(/voting power is 0/)] })
    expect(await why(() => {})).toMatchObject({ canVoteNow: true, voted: false, lastVoted: null, votedThisEpoch: false })
  })

  it('an NFT that exists only on LEGACY, or nowhere, is named as such and nothing else is read for it', async () => {
    const { ve } = setup({}, (w) => w.legacy.add(55n))
    const old: Json = await ve.status({ tokenId: '55' })
    expect(old.nft).toMatchObject({ exists: true, system: 'LEGACY', owner: STRANGER, note: expect.stringMatching(/LEGACY veBTC, whose distributor stopped/) })
    expect(old.nft.votingPower).toBeUndefined()
    const none: Json = await ve.status({ tokenId: '56' })
    expect(none.nft).toMatchObject({ exists: false, system: null, note: expect.stringMatching(/No veBTC NFT has this id/) })
  })

  it('bad token ids are input errors and cost no chain read', async () => {
    const { ve, rpc } = setup()
    for (const bad of ['abc', '0', '-1', '1.5', '', '1e3', '0x10', '1234567890123456789', ' ']) await expect(ve.status({ tokenId: bad }), JSON.stringify(bad)).rejects.toThrow(InputError)
    await expect(ve.rewards({ tokenId: 'x' })).rejects.toThrow(/tokenId must be a positive whole number/)
    expect(rpc.calls).toEqual([])
  })

  it('without a writer the tools have no write part', () => {
    expect(createVe(setup().rpc.client).write).toBeUndefined()
  })
})

describe('gauge_rewards', () => {
  it('ranks the pools by MUSD booked this epoch per unit of vote weight; a pool without votes and a dead gauge come after', async () => {
    const r: Json = await setup().ve.rewards()
    expect(r).toMatchObject({ blockNumber: 16482100, poolCount: 4, epoch: { start: '2026-10-29T00:00:00.000Z', next: '2026-11-05T00:00:00.000Z' } })
    expect(r.pools.map((p: Json) => [p.rank, p.index, p.name])).toEqual([[1, 0, 'MUSD Savings Rate'], [2, 1, 'Volatile AMM - MUSD/BTC'], [3, 2, null], [null, 3, 'Dead gauge pool']])
    expect(r.pools[0]).toMatchObject({ pool: pool(0), gauge: gaugeOf(0), votable: true, weight: '6.151227', musdFeesBooked: '22464.8801', musdFeesBookedLastEpoch: '21518.82', musdPerUnitWeight: '3652.097394', feeContract: feeOf(0), bribeContract: bribeOf(0) })
    expect(r.pools[1]).toMatchObject({ musdFeesBooked: '0.1153', musdPerUnitWeight: '0.013334' })
    expect(r.pools[2]).toMatchObject({ weight: '0', musdPerUnitWeight: null, noVotes: true })
    expect(r.pools[3]).toMatchObject({ votable: false, rank: null })
    expect(r.pools[0].yourVote).toBeUndefined()
    expect(r.claimable).toBeUndefined()
    expect(r.summary).toMatch(/4 pools\. Best MUSD fees per unit weight: 1\. MUSD Savings Rate \(3652\.097394\); 2\. Volatile AMM/)
  })

  it('a pool that books fees but has no votes ranks first (its fees are not shared with anyone yet)', async () => {
    const r: Json = await setup({}, (w) => (w.pools[2]!.booked = u('5'))).ve.rewards()
    expect(r.pools[0]).toMatchObject({ rank: 1, index: 2, noVotes: true, musdPerUnitWeight: null, musdFeesBooked: '5' })
    expect(r.pools[1]).toMatchObject({ rank: 2, index: 0 })
  })

  it('with a tokenId it adds the NFT\'s vote on each pool and what it can claim, with token symbols and decimals', async () => {
    const { ve } = setup({}, (w) => {
      w.nfts.set(1727n, nft({ owner: STRANGER, votes: new Map([[pool(0), 5n * 10n ** 13n]]) }))
      w.pools[1]!.bribeTokens = [TOKEN_T]
      w.earned.set(earnKey(feeOf(0), ADDRESSES.musd, 1727n), u('1.5'))
      w.earned.set(earnKey(bribeOf(1), TOKEN_T, 1727n), 2_500_000n)
      w.earned.set(earnKey(feeOf(1), ADDRESSES.musd, 99n), u('9')) // another NFT's reward is not listed
    })
    const r: Json = await ve.rewards({ tokenId: '1727' })
    expect(r.pools.map((p: Json) => p.yourVote)).toEqual(['0.00005', '0', '0', '0'])
    expect(r.claimable).toEqual([
      { kind: 'fee', pool: pool(0), poolName: 'MUSD Savings Rate', rewardContract: feeOf(0), token: ADDRESSES.musd, symbol: 'MUSD', amount: '1.5', raw: u('1.5').toString() },
      { kind: 'bribe', pool: pool(1), poolName: 'Volatile AMM - MUSD/BTC', rewardContract: bribeOf(1), token: TOKEN_T, symbol: 'BRB', amount: '2.5', raw: '2500000' },
    ])
    expect(r.unreadable).toBeUndefined()
    expect(r.summary).toMatch(/NFT 1727: 2 claimable rewards\./)
  })

  it('counts the reward contracts it could not read instead of hiding them', async () => {
    const r: Json = await setup({}, (w) => {
      w.nfts.set(1727n, nft({ owner: STRANGER }))
      w.failReads.add(`rewardsListLength:${bribeOf(1).toLowerCase()}`)
    }).ve.rewards({ tokenId: '1727' })
    expect(r).toMatchObject({ claimable: [], unreadable: 1 })
  })

  it('a pool census that fails comes back as an error, never as a partial ranking', async () => {
    await expect(setup({}, (w) => w.failReads.add('weights')).ve.rewards()).rejects.toThrow()
  })
})

describe('writes are off: every tool refuses with the writer\'s reason and reads nothing', () => {
  it('whatever the inputs are', async () => {
    const { write, rpc } = setup({ MEZO_WRITE_ENABLE: 'mainnet' })
    for (const r of [
      write.approveBtc({ amount: '0.004' }),
      write.lock({ amount: '0.004', days: 28 }),
      write.vote({ tokenId: '1', pools: [{ pool: pool(0), weight: 1 }] }),
      write.poke({ tokenId: '1' }),
      write.claimRewards({ tokenId: '1' }),
      write.claimRebase({ tokenId: '1' }),
    ]) expect(await reason(r)).toMatch(/writes are off \(the operator sets MEZO_WRITE_ENABLE=testnet/)
    expect(rpc.calls).toEqual([])
  })

  it('also when the setup is bad (no receipts file), and the message names no path', async () => {
    const { write, rpc } = setup({ MEZO_WRITE_RECEIPTS_FILE: undefined })
    const why = await reason(write.approveBtc({ amount: '0.004' }))
    expect(why).toMatch(/no receipts file is configured/)
    expect(why).not.toContain(root)
    expect(rpc.calls).toEqual([])
  })
})

describe('ve_approve_btc', () => {
  it('approves exactly the amount for veBTC, reads the allowance back and records the send', async () => {
    const { write, w, lines } = setup()
    const r = await write.approveBtc({ amount: ' 0.004 ' })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16482100', gasUsed: '123456', spender: ADDRESSES.veBTC, allowanceBefore: '0', allowance: '0.004' })
    expect((r as Json).explorer).toMatch(/^https:\/\/explorer\.test\.mezo\.org\/tx\/0x[0-9a-f]{64}$/)
    expect(w.sent).toHaveLength(1)
    expect(call(w)).toMatchObject({ to: ADDRESSES.btc, value: 0n })
    expect(decodeFunctionData({ abi: erc20Abi, data: call(w).data })).toEqual({ functionName: 'approve', args: [ADDRESSES.veBTC, u('0.004')] })
    expect(lines()).toMatchObject([{ name: 've_approve_btc', from: me, to: ADDRESSES.btc, selector: '0x095ea7b3', nonce: 7, status: 'success', musd: '0' }])
    expect(BigInt(lines()[0].btc)).toBeGreaterThan(u('0.004')) // the exact approve counts as BTC, plus the worst-case fee
  })

  it('refuses a zero or malformed amount, an amount over the cap, an unlimited-sized one and an allowance that is already exact', async () => {
    const a = setup()
    for (const bad of ['0', '-1', '1e18', 'abc', '0.0000000000000000001', '']) await expect(a.write.approveBtc({ amount: bad }), bad).rejects.toThrow(InputError)
    expect(await reason(a.write.approveBtc({ amount: '0.02' }))).toMatch(/0\.02 BTC \(gas fee included\) is over the per-call cap of 0\.01 BTC/)
    expect(await reason(a.write.approveBtc({ amount: '21000001' }))).toMatch(/cannot read the amounts in the ve_approve_btc calldata/)
    quiet(a.rpc)
    const b = setup({}, (w) => (w.allowance = u('0.004')))
    expect(await reason(b.write.approveBtc({ amount: '0.004' }))).toMatch(/veBTC already has an allowance of exactly 0\.004 BTC from this wallet/)
    beforeCore(b.rpc)
  })

  it('a chain read that fails before the send is a refusal, not a crash', async () => {
    const a = setup({}, (w) => w.failReads.add('allowance'))
    expect(await reason(a.write.approveBtc({ amount: '0.004' }))).toMatch(/a chain read failed before anything was sent/)
    beforeCore(a.rpc)
  })
})

describe('ve_lock', () => {
  it('locks for 28 days, takes the NFT id from the mint log (not from the ERC-20 transfer) and reads the lock back', async () => {
    const { write, w, lines } = setup({}, (w) => (w.allowance = u('0.004')))
    const r = await write.lock({ amount: '0.004', days: 28 })
    expect(r).toMatchObject({ sent: true, status: 'success', tokenId: '1900', amount: '0.004', unlocksAt: '2026-11-26T00:00:00.000Z', nextStep: expect.stringMatching(/next block.*ve_vote/) })
    expect(call(w)).toMatchObject({ to: ADDRESSES.veBTC, value: 0n })
    expect(decodeFunctionData({ abi: veBtcAbi, data: call(w).data })).toEqual({ functionName: 'createLock', args: [u('0.004'), 28n * 86_400n] })
    expect(w.allowance).toBe(0n) // the lock used the approval up
    expect(lines()).toMatchObject([{ name: 've_lock', to: ADDRESSES.veBTC, status: 'success' }])
  })

  it('without the mint log the lock still comes back as sent, with tokenId null and where to look', async () => {
    for (const logs of [[], [btcTransferLog(me, ADDRESSES.veBTC, u('0.004'))], [mintLog(7n, STRANGER)]]) {
      const { write } = setup({}, (w) => ((w.allowance = u('0.004')), (w.onTx = () => (w.logs = logs))))
      expect(await write.lock({ amount: '0.004', days: 28 })).toMatchObject({ sent: true, status: 'success', tokenId: null, readBack: expect.stringMatching(/new NFT id was not found in the receipt; list the wallet with ve_locks/) })
    }
  })

  it('rejects a bad length as input, and a lock that would end before now as a refusal', async () => {
    const s = setup({}, (w) => (w.allowance = u('0.004')))
    for (const days of [0, 29, 1.5, -1, Number.NaN, 365]) await expect(s.write.lock({ amount: '0.004', days }), `${days}`).rejects.toThrow(/days must be a whole number from 1 to 28/)
    await expect(s.write.lock({ amount: '0', days: 28 })).rejects.toThrow(InputError)
    // Saturday plus one day is a Sunday; the end is rounded down to Thursday 2026-10-29, which has already passed.
    expect(await reason(s.write.lock({ amount: '0.004', days: 1 }))).toMatch(/a 1-day lock would end at 2026-10-29T00:00:00\.000Z, which is not in the future/)
    beforeCore(s.rpc)
    // Five days from Saturday reach Thursday 2026-11-05 00:00Z, so that lock is allowed (it ends in under five days).
    const five = setup({}, (w) => (w.allowance = u('0.004')))
    expect(await five.write.lock({ amount: '0.004', days: 5 })).toMatchObject({ sent: true, unlocksAt: '2026-11-05T00:00:00.000Z' })
  })

  it('refuses when veBTC may not pull the amount yet or the wallet holds less', async () => {
    const a = setup({}, (w) => (w.allowance = u('0.003')))
    expect(await reason(a.write.lock({ amount: '0.004', days: 28 }))).toMatch(/veBTC may pull only 0\.003 BTC from this wallet; call ve_approve_btc for exactly 0\.004 first/)
    const b = setup({}, (w) => ((w.allowance = u('0.004')), (w.balance = u('0.001'))))
    expect(await reason(b.write.lock({ amount: '0.004', days: 28 }))).toMatch(/the wallet holds 0\.001 BTC, less than the 0\.004 BTC to lock/)
    beforeCore(a.rpc)
    beforeCore(b.rpc)
  })

  it('the write core\'s own refusals pass through: no risky flag, over the cap, kill file, a simulation that reverts', async () => {
    const funded = (w: World) => (w.allowance = u('0.02'))
    const risky = setup({ MEZO_WRITE_RISKY: undefined }, funded)
    expect(await reason(risky.write.lock({ amount: '0.004', days: 28 }))).toMatch(/ve_lock is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    const big = setup({}, funded)
    expect(await reason(big.write.lock({ amount: '0.02', days: 28 }))).toMatch(/over the per-call cap of 0\.01 BTC/)
    const killed = setup({}, funded)
    writeFileSync(join(killed.dir, 'STOP'), '')
    expect(await reason(killed.write.lock({ amount: '0.004', days: 28 }))).toMatch(/the kill file exists/)
    for (const c of [risky, big, killed]) quiet(c.rpc)
    const sim = setup({}, (w) => (funded(w), (w.simRevert = 'LockDurationNotInFuture')))
    expect(await reason(sim.write.lock({ amount: '0.004', days: 28 }))).toMatch(/the simulation reverted, so nothing was sent/)
    expect(sim.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(sim.lines()).toEqual([])
  })

  it('a read-back that fails after the send still reports the mined transaction', async () => {
    const { write, w, lines } = setup({}, (w) => ((w.allowance = u('0.004')), w.failReads.add('locked')))
    const r = await write.lock({ amount: '0.004', days: 28 })
    expect(r).toMatchObject({ sent: true, status: 'success', readBack: expect.stringMatching(/mined, but reading the result back failed/) })
    expect(w.sent).toHaveLength(1)
    expect(lines()).toHaveLength(1)
  })
})

describe('ve_vote', () => {
  const split = [{ pool: pool(0), weight: 100 }]

  it('votes 100% for one pool, reads the vote and the new pool weight back, and then refuses a second vote in the same epoch', async () => {
    const power = 3_600_000_000_000_000n
    const { write, w, lines } = setup({}, mine({ power }))
    const before = w.pools[0]!.weight
    const r = await write.vote({ tokenId: '1900', pools: split })
    expect(r).toMatchObject({ sent: true, status: 'success', tokenId: '1900', voted: true, lastVoted: '2026-10-31T09:16:29.000Z', usedWeights: '0.0036', pools: [{ pool: pool(0), relativeWeight: 100, yourVotes: '0.0036', poolWeight: '6.154827', raw: { yourVotes: power.toString(), poolWeight: (before + power).toString() } }] })
    expect(call(w)).toMatchObject({ to: ADDRESSES.poolsVoter, value: 0n })
    expect(decodeFunctionData({ abi: poolsVoterAbi, data: call(w).data })).toEqual({ functionName: 'vote', args: [1900n, [pool(0)], [100n]] })
    expect(lines()).toMatchObject([{ name: 've_vote', to: ADDRESSES.poolsVoter, status: 'success', btc: expect.any(String) }])
    expect(await reason(write.vote({ tokenId: '1900', pools: split }))).toMatch(/NFT 1900 already voted in this epoch \(at 2026-10-31T09:16:29\.000Z\); it can vote again after 2026-11-05T01:00:00\.000Z/)
    expect(w.sent).toHaveLength(1)
  })

  it('splits the weight by the relative numbers', async () => {
    const { write, w } = setup({}, mine({ power: 1_000_000_000_000_000n }))
    const r = await write.vote({ tokenId: '1900', pools: [{ pool: pool(0), weight: 60 }, { pool: pool(1), weight: 40 }] })
    expect(r).toMatchObject({ sent: true, pools: [{ yourVotes: '0.0006' }, { yourVotes: '0.0004' }] })
    expect(decodeFunctionData({ abi: poolsVoterAbi, data: call(w).data }).args).toEqual([1900n, [pool(0), pool(1)], [60n, 40n]])
  })

  it('is open to a whitelisted NFT in the last hour of the epoch, and to an approved operator that does not own the NFT', async () => {
    const a = setup({}, (w) => (mine({ whitelisted: true })(w), (w.ts = e.voteCloses + 60n)))
    expect(await reason(a.write.vote({ tokenId: '1900', pools: split }))).toBe('sent')
    const b = setup({}, mine({ owner: STRANGER, approved: true }))
    expect(await reason(b.write.vote({ tokenId: '1900', pools: split }))).toBe('sent')
  })

  it('refuses from what it reads: not the owner, no such NFT, the first or last hour, already voted, power 0, too many pools, bad pools', async () => {
    const dead = [{ pool: pool(3), weight: 1 }]
    const cases: [string, (w: World) => void, RegExp, typeof split?][] = [
      ['not the owner', mine({ owner: STRANGER }), /this wallet does not own NFT 1900 and is not approved for it/],
      ['no such NFT', () => {}, /NFT 1900 does not exist on the LIVE veBTC/],
      ['first hour', (w) => (mine()(w), (w.ts = e.start + 1800n)), /votes are closed in the epoch's first hour; they open after 2026-10-29T01:00:00\.000Z/],
      ['last hour', (w) => (mine()(w), (w.ts = e.voteCloses + 60n)), /votes are closed in the epoch's last hour; the next epoch opens to votes after 2026-11-05T01:00:00\.000Z/],
      ['voted this epoch', mine({ voted: true, lastVoted: e.start + 4000n }), /already voted in this epoch \(at 2026-10-29T01:06:40\.000Z\)/],
      ['voted exactly at the epoch start', mine({ lastVoted: e.start }), /already voted in this epoch/],
      ['power 0', mine({ power: 0n }), /voting power 0 in this block/],
      ['more pools than the voter takes', (w) => (mine()(w), (w.maxVotingNum = 0n)), /the voter accepts at most 0 pools per vote/],
      ['a dead gauge', mine(), /the gauge of 0x0000000000000000000000000000000000001003 is not alive/, dead],
      ['no gauge', mine(), /0x0000000000000000000000000000000000009999 is not a pool with a gauge on the LIVE voter/, [{ pool: addr(0x9999), weight: 1 }]],
    ]
    for (const [name, tweak, why, pools] of cases) {
      const c = setup({}, tweak)
      expect(await reason(c.write.vote({ tokenId: '1900', pools: pools ?? split })), name).toMatch(why)
      quiet(c.rpc)
      expect(c.w.sent, name).toEqual([])
    }
  })

  it('rejects malformed input before any read: ids, empty or oversized pool lists, weights, repeated or malformed pools', async () => {
    const { write, rpc } = setup({}, mine())
    const many = Array.from({ length: 31 }, (_, i) => ({ pool: pool(i), weight: 1 }))
    const bad: [Parameters<typeof write.vote>[0], RegExp][] = [
      [{ tokenId: 'x', pools: split }, /tokenId must be a positive whole number/],
      [{ tokenId: '1900', pools: [] }, /pools must list at least one pool/],
      [{ tokenId: '1900', pools: many }, /more than 30 pools/],
      [{ tokenId: '1900', pools: [{ pool: pool(0), weight: 0 }] }, /pools\[0\]\.weight must be a whole number from 1 to 10000/],
      [{ tokenId: '1900', pools: [{ pool: pool(0), weight: 1.5 }] }, /weight must be a whole number/],
      [{ tokenId: '1900', pools: [{ pool: pool(0), weight: 10_001 }] }, /weight must be a whole number/],
      [{ tokenId: '1900', pools: [{ pool: pool(0), weight: Number.NaN }] }, /weight must be a whole number/],
      [{ tokenId: '1900', pools: [{ pool: 'not an address', weight: 1 }] }, /pools\[0\]\.pool must be a 0x address/],
      [{ tokenId: '1900', pools: [{ pool: pool(0), weight: 1 }, { pool: pool(0), weight: 2 }] }, /lists the same pool twice/],
    ]
    for (const [input, why] of bad) await expect(write.vote(input), JSON.stringify(input).slice(0, 80)).rejects.toThrow(why)
    expect(rpc.calls).toEqual([])
  })
})

describe('an RPC node that is behind (the live RPC is several nodes behind one URL)', () => {
  const split = [{ pool: pool(0), weight: 100 }]
  /** From the moment the vote is sent, the next answers come from a node that has neither the receipt nor the block yet. */
  const behind = (lag: Partial<World['lag']>) => (w: World) => {
    mine({ power: 3_600_000_000_000_000n })(w)
    w.onTx = () => void Object.assign(w.lag, lag)
  }

  it('asks again for the receipt and the block, then reads the vote back at that block', async () => {
    const { write, w } = setup({}, behind({ receipts: 2, blocks: 2, calls: 2 }), { patienceMs: 5_000, retryMs: 1 })
    const r = await write.vote({ tokenId: '1900', pools: split })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16482100', gasUsed: '123456', voted: true, usedWeights: '0.0036' })
    expect(w.lag).toEqual({ receipts: 0, blocks: 0, calls: 0 }) // every answer from the lagging node was met with another ask
  })

  it('a receipt that does not arrive in time is said so; the state from before the vote is not shown as the result', async () => {
    const { write, w } = setup({}, behind({ receipts: 1_000 }), { patienceMs: 20, retryMs: 5 })
    const r = await write.vote({ tokenId: '1900', pools: split })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: null, gasUsed: null, readBack: expect.stringMatching(/did not return its receipt in time.*ve_status/) })
    expect(r).not.toHaveProperty('voted')
    expect(r).not.toHaveProperty('pools')
    expect(w.sent).toHaveLength(1)
  })
})

describe('ve_poke', () => {
  const voted = (over: Partial<FakeNft> = {}) => (w: World) => {
    mine({ voted: true, lastVoted: e.start + 4000n, used: 3_000_000_000_000_000n, power: 3_600_000_000_000_000n, votes: new Map([[pool(0), 3_000_000_000_000_000n]]), ...over })(w)
    w.pools[0]!.weight += 3_000_000_000_000_000n
  }

  it('re-applies the stored vote at the higher power and reads the new used weight back', async () => {
    const { write, w } = setup({}, voted())
    expect(await write.poke({ tokenId: '1900' })).toMatchObject({ sent: true, status: 'success', tokenId: '1900', usedWeights: '0.0036' })
    expect(call(w)).toMatchObject({ to: ADDRESSES.poolsVoter, value: 0n })
    expect(decodeFunctionData({ abi: poolsVoterAbi, data: call(w).data })).toEqual({ functionName: 'poke', args: [1900n] })
  })

  it('refuses unless the wallet owns the NFT, it has voted, and the poke would raise the weights', async () => {
    const cases: [string, (w: World) => void, RegExp][] = [
      ['approved only', voted({ owner: STRANGER, approved: true }), /does not own NFT 1900 \(poke is only sent for NFTs the wallet owns\)/],
      ['no such NFT', () => {}, /does not own NFT 1900/],
      ['first hour', (w) => (voted()(w), (w.ts = e.start + 100n)), /poke is closed in the epoch's first hour; it opens after 2026-10-29T01:00:00\.000Z/],
      ['never voted', mine(), /NFT 1900 has no vote to refresh; use ve_vote/],
      ['power decayed', voted({ power: 2_000_000_000_000_000n }), /poke would not raise the weights of NFT 1900/],
      ['power unchanged', voted({ power: 3_000_000_000_000_000n }), /poke would not raise the weights/],
    ]
    for (const [name, tweak, why] of cases) {
      const c = setup({}, tweak)
      expect(await reason(c.write.poke({ tokenId: '1900' })), name).toMatch(why)
      beforeCore(c.rpc)
    }
    await expect(setup().write.poke({ tokenId: '0' })).rejects.toThrow(InputError)
  })
})

describe('ve_claim_rewards', () => {
  const rewards = (w: World) => {
    mine()(w)
    w.pools[1]!.bribeTokens = [TOKEN_T]
    w.earned.set(earnKey(feeOf(0), ADDRESSES.musd, 1900n), u('1.5'))
    w.earned.set(earnKey(feeOf(1), ADDRESSES.musd, 1900n), u('0.25'))
    w.earned.set(earnKey(bribeOf(1), TOKEN_T, 1900n), 2_500_000n)
  }

  it('claims from the reward contracts and tokens it read from the chain, and reads what is left', async () => {
    const { write, w } = setup({}, rewards)
    const r = await write.claimRewards({ tokenId: '1900' })
    expect(r).toMatchObject({ sent: true, status: 'success', tokenId: '1900', stillClaimable: 0 })
    expect((r as Json).expected).toEqual([
      { kind: 'fee', pool: pool(0), token: ADDRESSES.musd, raw: u('1.5').toString() },
      { kind: 'fee', pool: pool(1), token: ADDRESSES.musd, raw: u('0.25').toString() },
      { kind: 'bribe', pool: pool(1), token: TOKEN_T, raw: '2500000' },
    ])
    expect(call(w)).toMatchObject({ to: ADDRESSES.poolsVoter, value: 0n })
    expect(decodeFunctionData({ abi: poolsVoterAbi, data: call(w).data })).toEqual({ functionName: 'claimFeesAndBribes', args: [[feeOf(0), feeOf(1), bribeOf(1)], [[ADDRESSES.musd], [ADDRESSES.musd], [TOKEN_T]], 1900n] })
  })

  it('refuses when the wallet does not own the NFT or nothing is claimable (fees booked this epoch are not yet earned)', async () => {
    const a = setup({}, (w) => (rewards(w), (w.nfts.get(1900n)!.owner = STRANGER)))
    expect(await reason(a.write.claimRewards({ tokenId: '1900' }))).toMatch(/does not own NFT 1900 \(claims are only sent for NFTs the wallet owns\)/)
    const b = setup({}, mine())
    expect(await reason(b.write.claimRewards({ tokenId: '1900' }))).toMatch(/NFT 1900 has nothing to claim from any gauge now/)
    beforeCore(a.rpc)
    beforeCore(b.rpc)
  })
})

describe('ve_claim_rebase', () => {
  it('claims the rebase the distributor holds for the NFT and reads the rest back', async () => {
    const { write, w } = setup({}, (w) => (mine()(w), w.rebase.set(1900n, u('0.0001'))))
    expect(await write.claimRebase({ tokenId: '1900' })).toMatchObject({ sent: true, status: 'success', tokenId: '1900', expected: '0.0001', claimableAfter: '0' })
    expect(call(w)).toMatchObject({ to: ADDRESSES.rewardsDistributor, value: 0n })
    expect(decodeFunctionData({ abi: rewardsDistributorAbi, data: call(w).data })).toEqual({ functionName: 'claim', args: [1900n] })
  })

  it('refuses when the wallet does not own the NFT or there is no rebase', async () => {
    const a = setup({}, (w) => (mine({ owner: STRANGER })(w), w.rebase.set(1900n, 1n)))
    expect(await reason(a.write.claimRebase({ tokenId: '1900' }))).toMatch(/does not own NFT 1900/)
    const b = setup({}, mine())
    expect(await reason(b.write.claimRebase({ tokenId: '1900' }))).toMatch(/the LIVE RewardsDistributor has no rebase to claim for NFT 1900 now/)
    beforeCore(a.rpc)
    beforeCore(b.rpc)
  })
})

describe('what a mined transaction reports', () => {
  it('a reverted receipt is status reverted, with no read-back and the spend still recorded', async () => {
    const { write, lines } = setup({}, (w) => ((w.txStatus = '0x0'), (w.allowance = u('0.004'))))
    const r = await write.lock({ amount: '0.004', days: 28 })
    expect(r).toMatchObject({ sent: true, status: 'reverted' })
    expect((r as Json).tokenId).toBeUndefined()
    expect(lines()).toMatchObject([{ name: 've_lock', status: 'reverted' }])
  })

  it('a receipt that never arrives is status unknown with no block, and the hash to look up', async () => {
    const { write, lines } = setup({}, (w) => (w.silent = true))
    const r = await write.approveBtc({ amount: '0.004' })
    expect(r).toMatchObject({ sent: true, status: 'unknown', blockNumber: null, gasUsed: null, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
    expect(lines()).toMatchObject([{ name: 've_approve_btc', status: 'unknown' }])
  })
})

describe('the real run, rehearsed on the fake chain: approve, lock, vote', () => {
  it('works under the caps of the real run, refuses a vote in the lock\'s own block, and a second approve passes no cap', async () => {
    const { write, w, lines } = setup({ MEZO_WRITE_MAX_BTC_PER_CALL: '0.00401', MEZO_WRITE_MAX_BTC_PER_DAY: '0.0081' })
    expect(await write.approveBtc({ amount: '0.004' })).toMatchObject({ sent: true, status: 'success', allowance: '0.004' })
    const lock = await write.lock({ amount: '0.004', days: 28 })
    expect(lock).toMatchObject({ sent: true, status: 'success', tokenId: '1900', unlocksAt: '2026-11-26T00:00:00.000Z' })
    // Voting power is 0 in the block the NFT arrives, so the tool refuses before it sends anything.
    const sentBefore = w.sent.length
    expect(await reason(write.vote({ tokenId: '1900', pools: [{ pool: pool(0), weight: 100 }] }))).toMatch(/voting power 0 in this block/)
    expect(w.sent).toHaveLength(sentBefore)
    w.block += 1n
    const vote = await write.vote({ tokenId: '1900', pools: [{ pool: pool(0), weight: 100 }] })
    expect(vote).toMatchObject({ sent: true, status: 'success', voted: true, pools: [{ pool: pool(0), relativeWeight: 100 }] })
    expect(w.sent.map((t) => t.to)).toEqual([ADDRESSES.btc, ADDRESSES.veBTC, ADDRESSES.poolsVoter])
    const spent = lines().reduce((sum, l) => sum + BigInt(l.btc), 0n)
    expect(spent).toBeGreaterThan(u('0.008'))
    expect(spent).toBeLessThan(u('0.0081')) // the day cap leaves no room for another 0.004
    expect(await reason(write.approveBtc({ amount: '0.004' }))).toMatch(/would pass the per-day cap of 0\.0081 BTC/)
    expect(w.sent).toHaveLength(3)
  })
})
