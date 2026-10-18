// Chain constants and the Mezo testnet contract addresses this toolkit touches. Testnet only: nothing here points at mainnet.
import { defineChain, type Address } from 'viem'

export const CHAIN_ID = 31611
export const NETWORK = 'eip155:31611' as const
export const RPC_URL = process.env.MEZO_RPC_URL ?? 'https://rpc.test.mezo.org'
export const FACILITATOR_URL = process.env.MEZO_FACILITATOR_URL ?? 'https://facilitator.vativ.io'
export const EXPLORER = 'https://explorer.test.mezo.org'
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`

export const mezoTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: EXPLORER } },
})

// Verified on the Mezo testnet explorer (proxies resolve to the implementations named in the README table).
export const ADDRESSES = {
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  btc: '0x7b7C000000000000000000000000000000000000', // native BTC through its ERC-20 precompile
  mezo: '0x7b7C000000000000000000000000000000000001', // native MEZO through its ERC-20 precompile
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  sortedTroves: '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  borrowerOperations: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
  poolRouter: '0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9',
  veBTC: '0xB63fcCd03521Cf21907627bd7fA465C129479231',
  veMEZO: '0xaCE816CA2bcc9b12C59799dcC5A959Fb9b98111b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  x402Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
} as const satisfies Record<string, Address>

export const TOKENS: Record<string, Address> = { BTC: ADDRESSES.btc, MUSD: ADDRESSES.musd, MEZO: ADDRESSES.mezo }
