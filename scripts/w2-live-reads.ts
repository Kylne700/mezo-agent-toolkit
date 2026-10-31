// Proves, with no key and no transaction, that the toolkit's veBTC reads work on the LIVE veBTC system:
// every veBTC function the lens calls is read directly at one block, and the lens built from artifacts/ runs against LIVE as a
// deployless eth_call (its bytecode is sent with the call, nothing is deployed) and must return the same values.
// Only eth_chainId, eth_getCode and eth_call are used; the block is pinned through Multicall3's getBlockNumber (itself an eth_call).
// Usage: tsx scripts/w2-live-reads.ts [tokenId]   (default 1727, a LIVE veNFT with an active, voted lock)
import { encodeDeployData, parseAbi, toFunctionSelector, type Abi, type Address, type Hex } from 'viem'
import artifact from '../artifacts/MezoLens.json' with { type: 'json' }
import deployment from '../deployments/testnet.json' with { type: 'json' }
import { veBtcAbi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, LEGACY_VE, RPC_URL } from '../src/config.ts'

const pub = publicClient()
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const extraAbi = parseAbi([
  'function getBlockNumber() view returns (uint256)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOfNFT(uint256 tokenId) view returns (uint256)',
  'function veBTC() view returns (address)',
  'function depositor() view returns (address)',
  'function activePeriod() view returns (uint256)',
])
let failed = false
const line = (ok: boolean, text: string) => {
  failed ||= !ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
}
const sel = (abi: Abi, name: string) => toFunctionSelector(abi.find((x) => x.type === 'function' && x.name === name) as never)
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString()

const id = BigInt(process.argv[2] ?? 1727)
const chainId = await pub.getChainId()
line(chainId === CHAIN_ID, `eth_chainId ${chainId} (${new URL(RPC_URL).origin})`)
const blockNumber = (await pub.readContract({ address: MULTICALL3, abi: extraAbi, functionName: 'getBlockNumber' })) as bigint
const now = (await pub.readContract({ address: MULTICALL3, abi: extraAbi, functionName: 'getCurrentBlockTimestamp', blockNumber })) as bigint
console.log(`     every read below is at block ${blockNumber} (${iso(now)})`)
const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>

console.log('\n# Code at every ve address in src/config.ts (eth_getCode)')
for (const [name, address] of [
  ...(['veBTC', 'poolsVoter', 'rewardsDistributor', 'boostVoter', 'veMEZO'] as const).map((k) => [`LIVE ${k}`, ADDRESSES[k]] as const),
  ...Object.entries(LEGACY_VE).map(([k, a]) => [`LEGACY ${k}`, a] as const),
]) {
  const code = await pub.getCode({ address, blockNumber })
  line(!!code && code.length > 2, `${name.padEnd(25)} ${address} ${code ? (code.length - 2) / 2 : 0} bytes`)
}

console.log(`\n# Every veBTC function the lens calls, read directly on LIVE veBTC ${ADDRESSES.veBTC} for NFT ${id}`)
const owner = await read<Address>(ADDRESSES.veBTC, extraAbi, 'ownerOf', [id])
console.log(`     ownerOf(${id}) = ${owner} (helper read, not a lens call)`)
const count = await read<bigint>(ADDRESSES.veBTC, veBtcAbi, 'balanceOf', [owner])
line(count > 0n, `balanceOf(owner)            ${sel(veBtcAbi, 'balanceOf')} = ${count}`)
const ids: bigint[] = []
for (let i = 0n; i < count && i < 25n; i++) ids.push(await read<bigint>(ADDRESSES.veBTC, veBtcAbi, 'ownerToNFTokenIdList', [owner, i]))
line(ids.includes(id), `ownerToNFTokenIdList(owner, i) ${sel(veBtcAbi, 'ownerToNFTokenIdList')} = [${ids.join(', ')}]`)
type Locked = { amount: bigint; end: bigint; isPermanent: boolean }
const direct = new Map<bigint, Locked & { votingPower: bigint; voted: boolean }>()
for (const t of ids) {
  const l = await read<Locked>(ADDRESSES.veBTC, veBtcAbi, 'locked', [t])
  const votingPower = await read<bigint>(ADDRESSES.veBTC, veBtcAbi, 'votingPowerOfNFT', [t])
  const voted = await read<boolean>(ADDRESSES.veBTC, veBtcAbi, 'voted', [t])
  direct.set(t, { ...l, votingPower, voted })
}
const d = direct.get(id)!
line(d.amount > 0n && (d.isPermanent || d.end > now), `locked(${id})                ${sel(veBtcAbi, 'locked')} = amount ${d.amount}, end ${d.end} (${d.isPermanent ? 'permanent' : iso(d.end)}), isPermanent ${d.isPermanent}`)
line(d.votingPower > 0n && d.votingPower <= d.amount * 5n, `votingPowerOfNFT(${id})      ${sel(veBtcAbi, 'votingPowerOfNFT')} = ${d.votingPower}`)
line(typeof d.voted === 'boolean', `voted(${id})                 ${sel(veBtcAbi, 'voted')} = ${d.voted}`)
const old = await read<bigint>(ADDRESSES.veBTC, extraAbi, 'balanceOfNFT', [id]).then(
  (v) => `returned ${v}`,
  (e: { shortMessage?: string }) => `reverts (${e.shortMessage ?? 'error'})`,
)
line(old.startsWith('reverts'), `balanceOfNFT(${id})          ${sel(extraAbi, 'balanceOfNFT')} ${old}: the W1 lens called this, LIVE veBTC does not have it`)

console.log('\n# The lens built from artifacts/MezoLens.json, run against LIVE as a deployless eth_call (nothing is deployed)')
const deployedVe = await read<Address>(deployment.MezoLens.address as Address, extraAbi, 'veBTC')
console.log(`     the lens deployed for Wave 1 (${deployment.MezoLens.address}) reads veBTC ${deployedVe}${deployedVe === LEGACY_VE.veBTC ? ' = LEGACY_VE.veBTC' : ''}`)
const args = [ADDRESSES.troveManager, ADDRESSES.sortedTroves, ADDRESSES.priceFeed, ADDRESSES.poolRouter, ADDRESSES.veBTC, ADDRESSES.veMEZO] as const // as scripts/deploy.ts
const code = encodeDeployData({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, args })
type Lock = Locked & { escrow: Address; tokenId: bigint; votingPower: bigint; voted: boolean; secondsLeft: bigint; expired: boolean }
const [locks, veBtcCount] = (await pub.readContract({ abi: artifact.abi as Abi, code, functionName: 'veLocks', args: [owner, 25n], blockNumber })) as readonly [Lock[], bigint, bigint]
line(veBtcCount === count, `veLocks(owner, 25): veBtcCount ${veBtcCount}, ${locks.length} locks returned`)
for (const k of locks.filter((x) => x.escrow === ADDRESSES.veBTC)) {
  const want = direct.get(k.tokenId)
  const left = k.isPermanent || k.end <= now ? 0n : k.end - now
  const same = !!want && k.amount === (want.amount > 0n ? want.amount : 0n) && k.end === want.end && k.isPermanent === want.isPermanent && k.votingPower === want.votingPower && k.voted === want.voted && k.secondsLeft === left
  line(same, `lens lock ${k.tokenId}: amount ${k.amount}, votingPower ${k.votingPower}, voted ${k.voted}, secondsLeft ${k.secondsLeft} ${same ? '= the direct reads' : '!= the direct reads'}`)
}

console.log('\n# Which system distributes: the rewards distributor\'s depositor and its active period')
for (const [name, rd] of [['LIVE', ADDRESSES.rewardsDistributor], ['LEGACY', LEGACY_VE.rewardsDistributor]] as const) {
  const dep = await read<Address>(rd, extraAbi, 'depositor')
  const period = await read<bigint>(dep, extraAbi, 'activePeriod')
  console.log(`     ${name.padEnd(6)} rewardsDistributor ${rd}: depositor ${dep}, activePeriod ${period} (${iso(period)})`)
}

console.log(failed ? '\nresult: FAIL' : '\nresult: ok')
process.exitCode = failed ? 1 : 0
