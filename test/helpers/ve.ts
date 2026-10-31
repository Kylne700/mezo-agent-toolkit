// A fake LIVE vote-escrow system behind the mocked Mezo RPC of helpers/write.ts: veBTC, poolsVoter, RewardsDistributor, the BTC precompile and
// four pools, all in memory. Tests change the world's fields between calls. No network, no real transaction.
import { decodeFunctionData, encodeFunctionResult, getAbiItem, getAddress, keccak256, pad, parseTransaction, toEventSelector, toFunctionSelector, toHex, zeroAddress, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import { depositorAbi, erc20Abi, poolNameAbi, poolsVoterAbi, rewardAbi, rewardsDistributorAbi, veBtcAbi } from '../../src/abis.ts'
import { ADDRESSES, LEGACY_VE } from '../../src/config.ts'
import { epochAt } from '../../src/ve-actions.ts'
import { mockRpc } from './write.ts'

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
export const pool = (i: number) => addr(0x1000 + i)
export const gaugeOf = (i: number) => addr(0x2000 + i)
export const feeOf = (i: number) => addr(0x3000 + i)
export const bribeOf = (i: number) => addr(0x4000 + i)
export const TOKEN_T = addr(0x5000) // a bribe token with 6 decimals
export const STRANGER = addr(0x7001)
const D_LIVE = addr(0x6001)
const D_OLD = addr(0x6002)
const e18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n

export interface FakePool {
  name?: string // undefined: name() reverts, as on some live pools
  weight: bigint
  booked: bigint // MUSD booked this epoch
  prev: bigint // MUSD booked last epoch
  alive: boolean
  bribeTokens: Address[]
}
export interface FakeNft {
  owner: Address
  amount: bigint
  end: bigint
  power: bigint
  voted: boolean
  lastVoted: bigint
  used: bigint
  whitelisted: boolean
  approved: boolean // approved for `me` although owned by someone else
  powerAt?: bigint // the first block in which `power` counts (a new NFT has 0 power in the block it arrives)
  votes: Map<Address, bigint>
}
export const earnKey = (reward: Address, token: Address, id: bigint) => `${reward}:${token}:${id}`.toLowerCase()
export const nft = (over: Partial<FakeNft> & { owner: Address }): FakeNft => ({ amount: 4_000_000_000_000_000n, end: 1_795_651_200n, power: 3_650_000_000_000_000n, voted: false, lastVoted: 0n, used: 0n, whitelisted: false, approved: false, votes: new Map(), ...over })

/** 2026-10-31T09:16:29Z, a Saturday inside the epoch that began on Thursday 2026-10-29 (the values the live voter reported). */
export const SAT = 1_793_438_189n

export interface Tx { to: Address; data: Hex; value: bigint }

export function veWorld(me: Address) {
  const w = {
    me,
    ts: SAT,
    block: 16_482_100n,
    allowance: 0n,
    balance: 49_799_998_929_591_656n,
    maxVotingNum: 30n,
    liveLag: 0n, // epochs the LIVE depositor is behind
    legacyActive: 1_762_992_000n,
    pools: [
      { name: 'MUSD Savings Rate', weight: e18(6.151227), booked: e18(22464.8801), prev: e18(21518.82), alive: true, bribeTokens: [] },
      { name: 'Volatile AMM - MUSD/BTC', weight: e18(8.646551), booked: e18(0.1153), prev: 0n, alive: true, bribeTokens: [] },
      { name: undefined, weight: 0n, booked: 0n, prev: 0n, alive: true, bribeTokens: [] },
      { name: 'Dead gauge pool', weight: e18(1), booked: e18(100), prev: 0n, alive: false, bribeTokens: [] },
    ] as FakePool[],
    nfts: new Map<bigint, FakeNft>(),
    legacy: new Set<bigint>(),
    earned: new Map<string, bigint>(), // keyed by earnKey(rewardContract, token, id)
    rebase: new Map<bigint, bigint>(),
    nextId: 1900n,
    failReads: new Set<string>(), // a function name ('locked') or a function at one contract ('rewardsListLength:0x...', lower case): those reads revert
    simRevert: undefined as string | undefined, // makes the write core's eth_call simulation revert
    txStatus: '0x1',
    silent: false, // no receipt ever arrives
    logs: [] as unknown[], // logs of the next receipt (the fake chain sets them for a createLock)
    onTx: undefined as ((tx: Tx) => void) | undefined, // an extra hook, called after the fake chain applied the tx
    sent: [] as Tx[],
  }
  const epoch = () => epochAt(w.ts)
  const powerOf = (n: FakeNft) => (w.block >= (n.powerAt ?? 0n) ? n.power : 0n)

  type Entry = { abi: Abi; name: string; fn: (...a: any[]) => unknown } // eslint-disable-line @typescript-eslint/no-explicit-any
  const table = () => {
    const t = new Map<string, Entry>()
    const on = (to: Address, abi: Abi, name: string, fn: Entry['fn']) => t.set(`${to.toLowerCase()}:${toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)}`, { abi, name, fn })
    const at = (i: number) => w.pools[i]!
    const index = (list: (i: number) => Address, a: Address) => w.pools.findIndex((_, i) => list(i).toLowerCase() === String(a).toLowerCase())
    const nftOf = (id: bigint) => w.nfts.get(id)

    on(ADDRESSES.btc, erc20Abi, 'allowance', (o: Address, s: Address) => (o.toLowerCase() === me.toLowerCase() && s.toLowerCase() === ADDRESSES.veBTC.toLowerCase() ? w.allowance : 0n))
    on(ADDRESSES.btc, erc20Abi, 'balanceOf', (a: Address) => (a.toLowerCase() === me.toLowerCase() ? w.balance : 0n))
    on(TOKEN_T, erc20Abi, 'symbol', () => 'BRB')
    on(TOKEN_T, erc20Abi, 'decimals', () => 6)
    on(ADDRESSES.musd, erc20Abi, 'symbol', () => 'MUSD')
    on(ADDRESSES.musd, erc20Abi, 'decimals', () => 18)

    on(ADDRESSES.veBTC, veBtcAbi, 'ownerOf', (id: bigint) => nftOf(id)?.owner ?? zeroAddress)
    on(ADDRESSES.veBTC, veBtcAbi, 'isApprovedOrOwner', (s: Address, id: bigint) => {
      const n = nftOf(id)
      return !!n && ((n.owner.toLowerCase() === s.toLowerCase()) || (n.approved && s.toLowerCase() === me.toLowerCase()))
    })
    on(ADDRESSES.veBTC, veBtcAbi, 'locked', (id: bigint) => ({ amount: nftOf(id)?.amount ?? 0n, end: nftOf(id)?.end ?? 0n, isPermanent: false }))
    on(ADDRESSES.veBTC, veBtcAbi, 'votingPowerOfNFT', (id: bigint) => { const n = nftOf(id); return n ? powerOf(n) : 0n })
    on(ADDRESSES.veBTC, veBtcAbi, 'voted', (id: bigint) => nftOf(id)?.voted ?? false)
    on(LEGACY_VE.veBTC, veBtcAbi, 'ownerOf', (id: bigint) => (w.legacy.has(id) ? STRANGER : zeroAddress))

    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'length', () => BigInt(w.pools.length))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'pools', (i: bigint) => pool(Number(i)))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'gauges', (p: Address) => (index(pool, p) >= 0 ? gaugeOf(index(pool, p)) : zeroAddress))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'gaugeToFees', (g: Address) => (index(gaugeOf, g) >= 0 ? feeOf(index(gaugeOf, g)) : zeroAddress))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'gaugeToBribe', (g: Address) => (index(gaugeOf, g) >= 0 ? bribeOf(index(gaugeOf, g)) : zeroAddress))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'isAlive', (g: Address) => index(gaugeOf, g) >= 0 && at(index(gaugeOf, g)).alive)
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'weights', (p: Address) => (index(pool, p) >= 0 ? at(index(pool, p)).weight : 0n))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'totalWeight', () => w.pools.reduce((s, p) => s + p.weight, 0n))
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'votes', (id: bigint, p: Address) => nftOf(id)?.votes.get(p as Address) ?? 0n)
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'lastVoted', (id: bigint) => nftOf(id)?.lastVoted ?? 0n)
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'usedWeights', (id: bigint) => nftOf(id)?.used ?? 0n)
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'maxVotingNum', () => w.maxVotingNum)
    on(ADDRESSES.poolsVoter, poolsVoterAbi, 'isWhitelistedNFT', (id: bigint) => nftOf(id)?.whitelisted ?? false)

    w.pools.forEach((p, i) => {
      if (p.name !== undefined) on(pool(i), poolNameAbi, 'name', () => p.name)
      on(feeOf(i), rewardAbi, 'rewardsListLength', () => 1n)
      on(feeOf(i), rewardAbi, 'rewards', () => ADDRESSES.musd)
      on(feeOf(i), rewardAbi, 'tokenRewardsPerEpoch', (_t: Address, start: bigint) => (start === epoch().start ? p.booked : start === epoch().start - 604_800n ? p.prev : 0n))
      on(feeOf(i), rewardAbi, 'earned', (token: Address, id: bigint) => w.earned.get(earnKey(feeOf(i), token, id)) ?? 0n)
      on(bribeOf(i), rewardAbi, 'rewardsListLength', () => BigInt(p.bribeTokens.length))
      on(bribeOf(i), rewardAbi, 'rewards', (k: bigint) => p.bribeTokens[Number(k)])
      on(bribeOf(i), rewardAbi, 'tokenRewardsPerEpoch', () => 0n)
      on(bribeOf(i), rewardAbi, 'earned', (token: Address, id: bigint) => w.earned.get(earnKey(bribeOf(i), token, id)) ?? 0n)
    })

    on(ADDRESSES.rewardsDistributor, rewardsDistributorAbi, 'depositor', () => D_LIVE)
    on(ADDRESSES.rewardsDistributor, rewardsDistributorAbi, 'claimable', (id: bigint) => w.rebase.get(id) ?? 0n)
    on(LEGACY_VE.rewardsDistributor, rewardsDistributorAbi, 'depositor', () => D_OLD)
    on(D_LIVE, depositorAbi, 'activePeriod', () => epoch().start - w.liveLag * 604_800n)
    on(D_OLD, depositorAbi, 'activePeriod', () => w.legacyActive)
    return t
  }

  /** What the fake chain does with each transaction the tools send, so a read-back sees the new state. */
  const index = (p: Address) => w.pools.findIndex((_, i) => pool(i).toLowerCase() === p.toLowerCase())
  const revote = (n: FakeNft, shares: Map<Address, bigint>) => {
    for (const [p, v] of n.votes) w.pools[index(p)]!.weight -= v
    n.votes = shares
    for (const [p, v] of shares) w.pools[index(p)]!.weight += v
    n.used = [...shares.values()].reduce((a, b) => a + b, 0n)
  }
  const react = (tx: Tx) => {
    w.logs = []
    const to = tx.to.toLowerCase()
    const is = (a: Address) => to === a.toLowerCase()
    if (is(ADDRESSES.btc)) {
      const d = decodeFunctionData({ abi: erc20Abi, data: tx.data })
      if (d.functionName === 'approve') w.allowance = d.args[1]
    } else if (is(ADDRESSES.veBTC)) {
      const d = decodeFunctionData({ abi: veBtcAbi, data: tx.data })
      if (d.functionName !== 'createLock') return
      const [value, duration] = d.args
      const id = w.nextId++
      w.balance -= value
      w.allowance -= value
      w.nfts.set(id, nft({ owner: me, amount: value, end: ((w.ts + duration) / 604_800n) * 604_800n, power: (value * 9n) / 10n, powerAt: w.block + 1n }))
      w.logs = [btcTransferLog(me, ADDRESSES.veBTC, value), mintLog(id, me)]
    } else if (is(ADDRESSES.poolsVoter)) {
      const d = decodeFunctionData({ abi: poolsVoterAbi, data: tx.data })
      if (d.functionName === 'vote') {
        const [id, pools, weights] = d.args
        const n = w.nfts.get(id)!
        const sum = weights.reduce((a, b) => a + b, 0n)
        revote(n, new Map(pools.map((p, i) => [p, (powerOf(n) * weights[i]!) / sum])))
        n.voted = true
        n.lastVoted = w.ts
      } else if (d.functionName === 'poke') {
        const n = w.nfts.get(d.args[0])!
        revote(n, new Map([...n.votes].map(([p, v]) => [p, (v * powerOf(n)) / n.used])))
      } else if (d.functionName === 'claimFeesAndBribes') {
        const [rewards, tokens, id] = d.args
        rewards.forEach((r, i) => tokens[i]!.forEach((t) => w.earned.delete(earnKey(r, t, id))))
      }
    } else if (is(ADDRESSES.rewardsDistributor)) {
      const d = decodeFunctionData({ abi: rewardsDistributorAbi, data: tx.data })
      if (d.functionName === 'claim') w.rebase.set(d.args[0], 0n)
    }
  }

  const header = () => ({ number: toHex(w.block), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(w.ts), baseFeePerGas: toHex(130n), transactions: [] })
  const over = {
    eth_blockNumber: () => toHex(w.block),
    eth_getBlockByNumber: () => header(),
    eth_getTransactionCount: () => toHex(7 + w.sent.length),
    eth_call: ([tx]: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const h = table().get(`${String(tx.to).toLowerCase()}:${String(tx.data).slice(0, 10)}`)
      if (tx.from) {
        // The write core simulates from the signer's address; reads never send `from`.
        if (w.simRevert) throw new Error(`execution reverted: ${w.simRevert}`)
        if (!h) return '0x'
      }
      if (!h) throw new Error('the fake chain has no handler for this call')
      if (w.failReads.has(h.name) || w.failReads.has(`${h.name}:${String(tx.to).toLowerCase()}`)) throw new Error('execution reverted')
      const args = decodeFunctionData({ abi: h.abi, data: tx.data }).args ?? []
      return encodeFunctionResult({ abi: h.abi, functionName: h.name, result: h.fn(...args) } as never)
    },
    eth_sendRawTransaction: ([raw]: Hex[]) => {
      const t = parseTransaction(raw)
      const tx = { to: getAddress(t.to as Address), data: (t.data ?? '0x') as Hex, value: t.value ?? 0n }
      w.sent.push(tx)
      react(tx)
      w.onTx?.(tx)
      return keccak256(raw)
    },
    eth_getTransactionByHash: () => {
      if (w.silent) return null
      throw new Error('the mock RPC has no eth_getTransactionByHash')
    },
    eth_getTransactionReceipt: ([hash]: Hex[]) =>
      w.silent
        ? null
        : { transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, blockNumber: toHex(w.block), cumulativeGasUsed: '0x5208', gasUsed: '0x1e240', effectiveGasPrice: '0x92', logs: w.logs, logsBloom: `0x${'00'.repeat(256)}`, status: w.txStatus, type: '0x2', contractAddress: null },
  }
  return { w, over, rpc: () => mockRpc(over) }
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const log = (address: Address, topics: Hex[], data: Hex = '0x') => ({ address, topics, data, blockNumber: '0x1', transactionHash: `0x${'22'.repeat(32)}`, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: '0x0', removed: false })
const word = (x: bigint | Address) => pad(typeof x === 'bigint' ? toHex(x) : x, { size: 32 })
/** The ERC-721 mint log of a createLock (4 topics). */
export const mintLog = (tokenId: bigint, to: Address) => log(ADDRESSES.veBTC, [TRANSFER, word(zeroAddress), word(to), word(tokenId)])
/** The ERC-20 Transfer the BTC precompile emits when veBTC pulls the BTC (3 topics): the tool must not take it for the NFT. */
export const btcTransferLog = (from: Address, to: Address, value: bigint) => log(ADDRESSES.btc, [TRANSFER, word(from), word(to)], word(value))

export type World = ReturnType<typeof veWorld>['w']
