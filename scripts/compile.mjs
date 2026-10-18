// Compiles the lens (the artifact is committed to artifacts/) and the test doubles (compiled in memory by the tests).
// No Foundry needed: the npm `solc` package runs in-process. Run `node scripts/compile.mjs` to rebuild artifacts/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

const root = fileURLToPath(new URL('../', import.meta.url))
export const SETTINGS = Object.freeze({
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris', // no PUSH0: the oldest target that every EVM chain accepts
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
})
export const LENS_PATH = 'contracts/MezoLens.sol'
export const MOCKS_PATH = 'contracts/test/Mocks.sol'

export const standardInput = (sources) => ({
  language: 'Solidity',
  sources: Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, { content }])),
  settings: SETTINGS,
})

export function compile(sources) {
  const out = JSON.parse(solc.compile(JSON.stringify(standardInput(sources))))
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
  return out
}

const read = (path) => ({ [path]: readFileSync(root + path, 'utf8') })
export const lensSources = () => read(LENS_PATH)

export function buildLensArtifact() {
  const c = compile(lensSources()).contracts[LENS_PATH].MezoLens
  return {
    contractName: 'MezoLens',
    source: LENS_PATH,
    compiler: solc.version(),
    settings: SETTINGS,
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    deployedBytecode: '0x' + c.evm.deployedBytecode.object,
  }
}

/** All test doubles: { MockTroveManager: { abi, bytecode }, ... } */
export function buildMocks() {
  const out = compile(read(MOCKS_PATH)).contracts[MOCKS_PATH]
  return Object.fromEntries(Object.entries(out).map(([name, c]) => [name, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = buildLensArtifact()
  mkdirSync(root + 'artifacts', { recursive: true })
  writeFileSync(root + 'artifacts/MezoLens.json', JSON.stringify(artifact, null, 2) + '\n')
  // The exact input for the explorer's "standard JSON" verification.
  writeFileSync(root + 'artifacts/MezoLens.standard-input.json', JSON.stringify(standardInput(lensSources()), null, 2) + '\n')
  console.log(`compiled MezoLens with solc ${artifact.compiler}: ${(artifact.deployedBytecode.length - 2) / 2} bytes deployed`)
}
