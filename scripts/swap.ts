// Swap a little testnet BTC for MUSD through the Mezo PoolRouter (the brief's route to get test MUSD without opening a trove).
// Usage: tsx scripts/swap.ts [btcAmount]   (default 0.0002). Writes evidence/swap.json (hashes and amounts only, no secrets).
import { mkdirSync, writeFileSync } from 'node:fs'
import { formatUnits, parseEther } from 'viem'
import { ADDRESSES, txUrl } from '../src/config.ts'
import { erc20Abi, routerAbi } from '../src/abis.ts'
import { publicClient, walletClient } from '../src/clients.ts'
import { opsAccount } from '../src/keys.ts'

const account = opsAccount()
const pub = publicClient()
const wallet = walletClient(account)
const amountIn = parseEther(process.argv[2] ?? '0.0002')
const { btc, musd, poolRouter } = ADDRESSES

const factory = await pub.readContract({ address: poolRouter, abi: routerAbi, functionName: 'defaultFactory' })
const routes = [{ from: btc, to: musd, stable: false, factory }] as const
const amounts = await pub.readContract({ address: poolRouter, abi: routerAbi, functionName: 'getAmountsOut', args: [amountIn, routes] })
const quoted = amounts[amounts.length - 1]
const amountOutMin = (quoted * 99n) / 100n // 1% slippage allowance
console.log(`quote: ${formatUnits(amountIn, 18)} BTC -> ${formatUnits(quoted, 18)} MUSD (min ${formatUnits(amountOutMin, 18)})`)

const out: Record<string, unknown> = { network: 'eip155:31611', router: poolRouter, factory, amountInBtc: formatUnits(amountIn, 18), quotedMusd: formatUnits(quoted, 18) }
const allowance = await pub.readContract({ address: btc, abi: erc20Abi, functionName: 'allowance', args: [account.address, poolRouter] })
if (allowance < amountIn) {
  const h = await wallet.writeContract({ address: btc, abi: erc20Abi, functionName: 'approve', args: [poolRouter, amountIn] })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  out.approveTx = h
  console.log('approve', r.status, txUrl(h))
  const after = await pub.readContract({ address: btc, abi: erc20Abi, functionName: 'allowance', args: [account.address, poolRouter] })
  console.log('allowance read back:', formatUnits(after, 18), 'BTC')
  if (after < amountIn) throw new Error('allowance read back is below the swap amount; the BTC precompile did not record the approval')
}
const before = await pub.readContract({ address: musd, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
const hash = await wallet.writeContract({ address: poolRouter, abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [amountIn, amountOutMin, routes, account.address, deadline] })
const receipt = await pub.waitForTransactionReceipt({ hash })
const afterBal = await pub.readContract({ address: musd, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
out.swapTx = hash
out.swapBlock = receipt.blockNumber.toString()
out.status = receipt.status
out.musdBefore = formatUnits(before, 18)
out.musdAfter = formatUnits(afterBal, 18)
console.log('swap', receipt.status, txUrl(hash), 'MUSD', formatUnits(before, 18), '->', formatUnits(afterBal, 18))
mkdirSync(new URL('../evidence/', import.meta.url), { recursive: true })
writeFileSync(new URL('../evidence/swap.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
if (receipt.status !== 'success' || afterBal <= before) process.exit(1)
