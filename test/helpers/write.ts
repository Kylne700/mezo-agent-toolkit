// Shared fixtures for the write-path tests: fake allow-list entries and a mocked Mezo RPC (no network, no real transaction).
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseUnits, toFunctionSelector, toHex, type Hex } from 'viem'
import { erc20Abi } from '../../src/abis.ts'
import { ADDRESSES, mezoTestnet } from '../../src/config.ts'
import type { AllowEntry } from '../../src/policy.ts'

export const u = (x: string) => parseUnits(x, 18)
export const OTHER = '0x000000000000000000000000000000000000dEaD'
const erc20Amount = (data: Hex) => (decodeFunctionData({ abi: erc20Abi, data }).args as readonly unknown[])[1] as bigint
export const transfer: AllowEntry = { name: 'musd.transfer', contract: ADDRESSES.musd, selector: toFunctionSelector('transfer(address,uint256)'), amounts: (d) => ({ musd: erc20Amount(d), btc: 0n }) }
export const approve: AllowEntry = { name: 'musd.approve', contract: ADDRESSES.musd, selector: toFunctionSelector('approve(address,uint256)'), risky: true, amounts: (d) => ({ musd: erc20Amount(d), btc: 0n }) }
// Declares nothing: the core must still count the tx value as BTC.
export const liar: AllowEntry = { name: 'liar', contract: ADDRESSES.borrowerOperations, selector: toFunctionSelector('addColl(address,address)'), amounts: () => ({ musd: 0n, btc: 0n }) }
export const allow = [transfer, approve, liar]
export const caps = { MEZO_WRITE_MAX_MUSD_PER_CALL: '1', MEZO_WRITE_MAX_MUSD_PER_DAY: '2', MEZO_WRITE_MAX_BTC_PER_CALL: '0.01', MEZO_WRITE_MAX_BTC_PER_DAY: '0.02' }

export const pay = (musd: string, fn: 'transfer' | 'approve' = 'transfer', to: Hex = ADDRESSES.musd) => ({ to, data: encodeFunctionData({ abi: erc20Abi, functionName: fn, args: [OTHER, u(musd)] }), value: 0n })
export const addColl = (btc: string) => ({ to: ADDRESSES.borrowerOperations, data: encodeFunctionData({ abi: parseAbi(['function addColl(address, address) payable']), functionName: 'addColl', args: [OTHER, OTHER] }), value: u(btc) })

type Handler = (params: any[]) => unknown

/** A Mezo testnet RPC in memory. Every request is recorded; a method without a handler fails the call. */
export function mockRpc(over: Record<string, Handler> = {}) {
  const calls: { method: string; params: any[] }[] = []
  let sent = 0
  const handlers: Record<string, Handler> = {
    eth_chainId: () => toHex(31611),
    eth_call: () => '0x',
    eth_estimateGas: () => toHex(100_000),
    eth_getTransactionCount: () => toHex(7 + sent),
    eth_getBlockByNumber: () => ({ number: '0x64', hash: `0x${'11'.repeat(32)}`, timestamp: '0x6900', baseFeePerGas: toHex(10_000_000), transactions: [] }),
    eth_maxPriorityFeePerGas: () => toHex(1_000_000),
    eth_sendRawTransaction: ([raw]) => {
      sent++
      return keccak256(raw)
    },
    eth_getTransactionReceipt: ([hash]) => ({ transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, blockNumber: '0x65', cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x989680', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2', contractAddress: null }),
    eth_blockNumber: () => '0x65',
    ...over,
  }
  const client = createPublicClient({
    chain: mezoTestnet,
    pollingInterval: 5,
    transport: custom({
      async request({ method, params }) {
        calls.push({ method, params })
        const h = handlers[method]
        if (!h) throw new Error(`the mock RPC has no ${method}`)
        return h(params)
      },
    }, { retryCount: 0 }),
  })
  return { client, calls, methods: () => calls.map((c) => c.method), raws: () => calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.params[0] as Hex) }
}
