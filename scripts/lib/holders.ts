// Finds an address that holds veBTC locks right now, using the explorer's token holder list (a read-only HTTP call; the chain has no on-chain index for this).
import { getAddress, type Address } from 'viem'
import { ADDRESSES } from '../../src/config.ts'

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
