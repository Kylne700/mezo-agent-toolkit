// Submits the lens source to the Mezo testnet explorer (Blockscout) for verification, with the exact standard-JSON input we compiled.
// Reads artifacts/MezoLens.standard-input.json and deployments/testnet.json; then polls the explorer for the verified flag.
import { readFileSync } from 'node:fs'

const API = 'https://api.explorer.test.mezo.org/api/v2'
const art = JSON.parse(readFileSync(new URL('../artifacts/MezoLens.json', import.meta.url), 'utf8'))
const dep = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'))
const address: string = dep.MezoLens.address
const input = readFileSync(new URL('../artifacts/MezoLens.standard-input.json', import.meta.url), 'utf8')
const isVerified = async () => Boolean(((await (await fetch(`${API}/smart-contracts/${address}`)).json()) as { is_verified?: boolean }).is_verified)

if (await isVerified()) { console.log('already verified:', address); process.exit(0) }

const form = new FormData()
form.set('compiler_version', 'v' + String(art.compiler).replace(/\.Emscripten.*$/, '')) // v0.8.37+commit.f401782d
form.set('license_type', 'mit')
form.set('autodetect_constructor_args', 'true')
form.set('contract_name', 'MezoLens')
form.set('files[0]', new Blob([input], { type: 'application/json' }), 'standard-input.json')
const res = await fetch(`${API}/smart-contracts/${address}/verification/via/standard-input`, { method: 'POST', body: form })
console.log('submit:', res.status, (await res.text()).slice(0, 300))

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  if (await isVerified()) { console.log('verified:', `https://explorer.test.mezo.org/address/${address}?tab=contract`); process.exit(0) }
}
console.log('NOT verified after 60 s (check the explorer; the compiler version may be missing from its list)')
process.exit(1)
