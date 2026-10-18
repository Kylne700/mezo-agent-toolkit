// Deploys MezoLens to the Mezo testnet with the throwaway ops key and records the result in deployments/testnet.json.
// Run `npm run build:contracts` first. Refuses to deploy again when the recorded address still has code; pass --force to deploy a new one.
import { readFileSync, writeFileSync } from 'node:fs'
import { getAddress } from 'viem'
import { ADDRESSES, CHAIN_ID, addressUrl, txUrl } from '../src/config.ts'
import { publicClient, walletClient } from '../src/clients.ts'
import { opsAccount } from '../src/keys.ts'

const artifact = JSON.parse(readFileSync(new URL('../artifacts/MezoLens.json', import.meta.url), 'utf8'))
const recordUrl = new URL('../deployments/testnet.json', import.meta.url)
const pub = publicClient()

let existing: { MezoLens?: { address: `0x${string}` } } = {}
try { existing = JSON.parse(readFileSync(recordUrl, 'utf8')) } catch { /* first deployment */ }
if (existing.MezoLens && !process.argv.includes('--force')) {
  const code = await pub.getCode({ address: existing.MezoLens.address })
  if (code && code !== '0x') { console.log(`MezoLens is already deployed at ${existing.MezoLens.address} (use --force to deploy a new one)`); process.exit(0) }
}

const account = opsAccount()
const args = [ADDRESSES.troveManager, ADDRESSES.sortedTroves, ADDRESSES.priceFeed, ADDRESSES.poolRouter, ADDRESSES.veBTC, ADDRESSES.veMEZO] as const
const hash = await walletClient(account).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args })
console.log('deploy tx', txUrl(hash))
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deployment failed (status ${receipt.status})`)
const code = await pub.getCode({ address: receipt.contractAddress })
if (!code || code === '0x') throw new Error('no code at the deployed address')

const address = getAddress(receipt.contractAddress)
const record = {
  network: `eip155:${CHAIN_ID}`,
  MezoLens: {
    address,
    txHash: hash,
    blockNumber: Number(receipt.blockNumber),
    deployer: account.address,
    constructorArgs: { troveManager: args[0], sortedTroves: args[1], priceFeed: args[2], router: args[3], veBTC: args[4], veMEZO: args[5] },
    compiler: artifact.compiler,
    deployedCodeBytes: (code.length - 2) / 2,
    explorer: addressUrl(address),
  },
}
writeFileSync(recordUrl, JSON.stringify(record, null, 2) + '\n')
console.log(`MezoLens at ${address} (block ${receipt.blockNumber}, ${record.MezoLens.deployedCodeBytes} bytes of code)`)
