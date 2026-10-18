// Shared viem clients for the Mezo testnet. Read paths need no key; write paths take an account loaded by src/keys.ts.
import { createPublicClient, createWalletClient, http, type Account } from 'viem'
import { RPC_URL, mezoTestnet } from './config.ts'

export const publicClient = () => createPublicClient({ chain: mezoTestnet, transport: http(RPC_URL) })
export const walletClient = (account: Account) => createWalletClient({ account, chain: mezoTestnet, transport: http(RPC_URL) })
