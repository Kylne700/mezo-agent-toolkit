// Bundles the stdio MCP server and every library it uses into one file, dist/mcp.js, so `npx -y mezo-agent-toolkit` has nothing else to install.
// esbuild is already in node_modules as a dependency of tsx. Usage: npm run build:mcp
import { build } from 'esbuild'
import { chmodSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outfile = root + 'dist/mcp.js'

await build({
  absWorkingDir: root, // the module comments in the bundle then read src/..., not a path from wherever the build was started
  entryPoints: [root + 'src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof', // keeps the licence notices of the bundled libraries at the end of the file
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
})
chmodSync(outfile, 0o755)
console.log(`built dist/mcp.js (${Math.round(statSync(outfile).size / 1024)} kB)`)
