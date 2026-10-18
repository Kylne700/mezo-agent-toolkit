// CLI entry for the paid endpoint: `npm run serve`. Reads PORT (default 8402), HOST (default 127.0.0.1) and PAYEE_ADDRESS from the environment.
import { startServer } from './serve.ts'

const s = await startServer({ port: Number(process.env.PORT ?? 8402), host: process.env.HOST ?? '127.0.0.1' })
console.log(JSON.stringify({ event: 'listening', url: s.url, lens: s.lens.address, payTo: s.payTo }))
const stop = () => void s.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
