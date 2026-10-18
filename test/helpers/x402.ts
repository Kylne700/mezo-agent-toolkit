// Offline stand-ins for the outside world of the paid endpoint: the facilitator, the lens and the chain. Nothing here touches the network.
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import type { FacilitatorClient } from '@x402/core/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { parseUnits, type Address, type Hex } from 'viem'
import { createApp } from '../../src/app.ts'
import { ADDRESSES, NETWORK } from '../../src/config.ts'
import type { Lens } from '../../src/lens.ts'
import { createBuyer } from '../../src/pay.ts'
import type { LogReader } from '../../src/recover.ts'
import { SpendGuard } from '../../src/spend.ts'
import supported from '../fixtures/facilitator-supported.json' with { type: 'json' }

export const PAYEE: Address = '0xa37a04189696C371f487ff8da414192D62f39A4f'
export const LENS_ADDRESS: Address = '0xBDfD1C0B544319E25b4b99ee1f355e55230f6130'
export const TROVE: Address = '0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa'
export const PRICE_BASE_UNITS = '1000000000000000' // $0.001 as MUSD base units (18 decimals)

/** A random throwaway key that lives only for this test run and never holds anything. */
export const testAccount = () => privateKeyToAccount(generatePrivateKey())

/** Stands in for a viem public client on the buyer side: the signer only reads allowances and permit nonces, and zero is a valid answer. */
export const zeroReader = { readContract: async () => 0n }

export const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`

type SettleResult = Awaited<ReturnType<FacilitatorClient['settle']>>
type SettlePayload = Parameters<FacilitatorClient['settle']>[0]

export interface FakeFacilitator extends FacilitatorClient {
  verifies: number
  settles: number
  /** Every payload the app asked it to settle. */
  payloads: SettlePayload[]
}

export const payerOf = (p: SettlePayload): string => (p.payload as { permit2Authorization?: { from: string } }).permit2Authorization?.from ?? ''
export const signatureOf = (p: SettlePayload): string => (p.payload as { signature: string }).signature

/** Accepts every payment and settles it, unless `settle` says otherwise. Serves the recorded /supported answer of the real facilitator. */
export function fakeFacilitator(settle?: (n: number, p: SettlePayload) => SettleResult): FakeFacilitator {
  const f: FakeFacilitator = {
    verifies: 0,
    settles: 0,
    payloads: [],
    async verify(p) {
      f.verifies++
      return { isValid: true, payer: payerOf(p as SettlePayload) }
    },
    async settle(p, r) {
      f.settles++
      f.payloads.push(p)
      return settle ? settle(f.settles, p) : { success: true, payer: payerOf(p), transaction: txHash(f.settles), network: r.network }
    },
    async getSupported() {
      return supported as never
    },
  }
  return f
}

/** A settlement that fails the way the real one did: the facilitator could not read the receipt of a transaction it had broadcast. */
export const receiptCrash = (): SettleResult => ({
  success: false,
  errorReason: 'unexpected_error',
  errorMessage: 'An internal error was received.\n\nURL: https://rpc.test.mezo.org\nDetails: method handler crashed',
  transaction: '',
  network: NETWORK,
})

/** A lens that answers instantly with recognisable data, or throws when told to. */
export function fakeLens(over: Partial<Lens> = {}): Lens {
  const meta = { blockNumber: 123, blockTime: '2026-10-18T00:00:00.000Z', chainId: 31611, lens: LENS_ADDRESS }
  return {
    address: LENS_ADDRESS,
    troveHealth: async (borrower: string) => ({ ...meta, borrower, status: 'active' }),
    systemSnapshot: async () => ({ ...meta }),
    redemptionRisk: async (borrower: string) => ({ ...meta, borrower, found: true }),
    poolQuote: async (input: { amountIn: string }) => ({ ...meta, amountIn: input.amountIn }),
    veLocks: async (owner: string) => ({ ...meta, owner }),
    ...over,
  } as unknown as Lens
}

export interface FakeTransfer {
  hash: Hex
  value: bigint
  /** The calldata the transaction is said to carry; a function when it depends on a payment signed during the test. */
  input: string | (() => string)
}

/** A chain with a fixed list of MUSD transfers. getLogs answers with all of them; getTransaction knows only their hashes. */
export function fakeChain(transfers: FakeTransfer[], o: { failReads?: boolean } = {}): LogReader & { logCalls: unknown[] } {
  const chain = {
    logCalls: [] as unknown[],
    async getBlockNumber() {
      if (o.failReads) throw new Error('method handler crashed')
      return 1000n
    },
    async getLogs(args: unknown) {
      chain.logCalls.push(args)
      return transfers.map((t) => ({ transactionHash: t.hash, args: { value: t.value } }))
    },
    async getTransaction({ hash }: { hash: Hex }) {
      const t = transfers.find((x) => x.hash === hash)
      if (!t) throw new Error('transaction not found')
      return { input: typeof t.input === 'function' ? t.input() : t.input }
    },
  }
  return chain
}

/**
 * A complete paying world with no network: the real app (priced `price`) behind a fake facilitator, and a real buyer whose fetch goes straight into the app.
 * `wrap` lets a test break or rewrite the network, for example to drop the connection exactly when the payment is sent.
 */
export function payWorld(o: { price?: string; perCall?: string; perSession?: string; allowedHosts?: string[]; wrap?: (real: typeof fetch) => typeof fetch } = {}) {
  const facilitator = fakeFacilitator()
  const app = createApp({ lens: fakeLens(), payTo: PAYEE, facilitator, price: o.price })
  const calls: string[] = []
  const real: typeof fetch = (input, init) => {
    calls.push(input instanceof Request ? input.url : String(input))
    return Promise.resolve(app.fetch(new Request(input as Request | string, init)))
  }
  const fetchImpl = o.wrap ? o.wrap(real) : real
  const guard = new SpendGuard({ perCall: parseUnits(o.perCall ?? '0.01', 18), perSession: parseUnits(o.perSession ?? '0.1', 18) })
  const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard, fetchImpl, allowedHosts: o.allowedHosts })
  return { buyer, guard, facilitator, calls }
}

/** What our own server asks for, written as a seller puts it in a challenge. Override any field to play a hostile seller. */
export const musdRequirement = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: NETWORK,
  asset: ADDRESSES.musd,
  amount: PRICE_BASE_UNITS,
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'permit2', name: 'Mezo USD', version: '1' },
  ...over,
})

/** A seller with no app behind it: an unpaid GET gets `challenge` as a 402, a paid one gets `paid()` (default: a 200 with no receipt). It keeps every payment it is sent. */
export function rawSeller(challenge: { accepts: unknown[]; extensions?: Record<string, unknown> }, paid: () => Response = () => new Response('{}', { status: 200 })) {
  const payments: ReturnType<typeof decodePaymentSignatureHeader>[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const req = input as Request
    const signature = req.headers.get('payment-signature')
    if (signature) {
      payments.push(decodePaymentSignatureHeader(signature))
      return paid()
    }
    const required = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: req.url }, ...challenge } as never)
    return new Response('{}', { status: 402, headers: { 'payment-required': required } })
  }
  return { fetchImpl, payments }
}
