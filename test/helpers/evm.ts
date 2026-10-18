// A tiny in-process EVM (@ethereumjs/evm, dev-only) so the lens can be tested against mock Mezo contracts without Foundry or a node.
import { createEVM, type EVM } from '@ethereumjs/evm'
import { bytesToHex, createAddressFromString, createZeroAddress, hexToBytes } from '@ethereumjs/util'
import { decodeErrorResult, decodeFunctionResult, encodeDeployData, encodeFunctionData, type Abi, type Hex } from 'viem'

export const NOW = 1_800_000_000n // block.timestamp seen by the contracts
const CALLER = createAddressFromString('0x1111111111111111111111111111111111111111')
const GAS = 5_000_000_000n

export type Compiled = { abi: Abi; bytecode: Hex }

export class Chain {
  private constructor(readonly evm: EVM) {}
  static async create() { return new Chain(await createEVM()) }

  private block() {
    return { header: { number: 1n, coinbase: createZeroAddress(), timestamp: NOW, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: GAS, baseFeePerGas: undefined, slotNumber: 0n, getBlobGasPrice: () => undefined } } as never
  }

  async deploy(c: Compiled, args: unknown[] = []): Promise<Hex> {
    const data = hexToBytes(encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args }))
    const r = await this.evm.runCall({ caller: CALLER, data, gasLimit: GAS, block: this.block() })
    if (r.execResult.exceptionError || !r.createdAddress) throw new Error(`deploy failed: ${revertReason(c.abi, r.execResult.returnValue) ?? r.execResult.exceptionError?.error}`)
    return r.createdAddress.toString() as Hex
  }

  /** Runs a call (state changes persist, like a transaction) and returns the decoded result plus the gas used. */
  async call<T = unknown>(to: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<{ result: T; gas: bigint }> {
    const data = hexToBytes(encodeFunctionData({ abi, functionName, args }))
    const r = await this.evm.runCall({ caller: CALLER, to: createAddressFromString(to), data, gasLimit: GAS, block: this.block() })
    if (r.execResult.exceptionError) throw new Error(revertReason(abi, r.execResult.returnValue) ?? r.execResult.exceptionError.error)
    return { result: decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) }) as T, gas: r.execResult.executionGasUsed }
  }
}

function revertReason(abi: Abi, data: Uint8Array): string | undefined {
  if (!data.length) return undefined
  try { const e = decodeErrorResult({ abi, data: bytesToHex(data) }); return `${e.errorName}(${(e.args ?? []).join(',')})` } catch { /* not in the abi */ }
  try { return decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], data: bytesToHex(data) }).args?.[0] as string } catch { return undefined }
}
