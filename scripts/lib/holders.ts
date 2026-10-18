// Finds an address that holds veBTC locks right now, using the explorer's token holder list (a read-only HTTP call; the chain has no on-chain index for this).
import { getAddress, parseAbi, type Address } from 'viem'
import { veBtcAbi, veMezoAbi } from '../../src/abis.ts'
import { ADDRESSES } from '../../src/config.ts'
import { withRetry, type ReadClient } from '../../src/lens.ts'

const API = 'https://api.explorer.test.mezo.org/api/v2'

/** A holder with a small number of locks (1 to 5) if there is one, otherwise the first holder. Undefined when nobody holds a lock. */
export async function discoverVeHolder(escrow: Address = ADDRESSES.veBTC): Promise<Address | undefined> {
  const res = await fetch(`${API}/tokens/${escrow}/holders`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return undefined
  const body = (await res.json()) as { items?: { address?: { hash?: string }; value?: string }[] }
  const items = (body.items ?? []).filter((i) => i.address?.hash)
  const small = items.find((i) => Number(i.value) >= 1 && Number(i.value) <= 5)
  const pick = small ?? items[0]
  return pick?.address?.hash ? getAddress(pick.address.hash) : undefined
}

const counterAbi = parseAbi(['function tokenId() view returns (uint256)', 'function ownerOf(uint256) view returns (address)'])

export interface LiveLock {
  owner: Address
  escrow: 'veBTC' | 'veMEZO'
  tokenId: bigint
  secondsLeft: bigint
}

/** The owner of a lock that has not expired yet at `blockNumber` (so `secondsLeft` is a real number, not zero), found among the newest token ids of veBTC and then veMEZO. A few reads. */
export async function discoverLiveLock(pub: ReadClient, blockNumber: bigint, look = 30n): Promise<LiveLock | undefined> {
  const read = <T>(address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) => withRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>)
  const now = (await withRetry(() => pub.getBlock({ blockNumber }))).timestamp
  for (const [escrow, address, abi] of [['veBTC', ADDRESSES.veBTC, veBtcAbi], ['veMEZO', ADDRESSES.veMEZO, veMezoAbi]] as const) {
    const newest = await read<bigint>(address, counterAbi, 'tokenId')
    for (let id = newest; id > 0n && id > newest - look; id--) {
      const l = await read<{ end: bigint; isPermanent: boolean }>(address, abi, 'locked', [id])
      if (l.isPermanent || l.end <= now + 3600n) continue // keep an hour of margin so it does not expire while a script runs
      return { owner: await read<Address>(address, counterAbi, 'ownerOf', [id]), escrow, tokenId: id, secondsLeft: l.end - now }
    }
  }
  return undefined
}
