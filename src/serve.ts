// Starts the paid endpoint under Node. Used by the CLI entry (server.ts) and by the scripts that need a live server on a free port.
import { serve } from '@hono/node-server'
import type { FacilitatorClient } from '@x402/core/server'
import type { Hono } from 'hono'
import { getAddress, type Address } from 'viem'
import { createApp } from './app.ts'
import { publicClient } from './clients.ts'
import { DEFAULT_PAYEE } from './config.ts'
import { createLens, type Lens } from './lens.ts'

export interface StartOptions {
  /** 0 picks a free port. */
  port?: number
  host?: string
  payTo?: Address
  price?: string
  lens?: Lens
  facilitator?: FacilitatorClient
}

export interface RunningServer {
  app: Hono
  url: string
  port: number
  payTo: Address
  lens: Lens
  close(): Promise<void>
}

export async function startServer(o: StartOptions = {}): Promise<RunningServer> {
  const client = publicClient()
  const lens = o.lens ?? createLens(client)
  const payTo = o.payTo ?? getAddress(process.env.PAYEE_ADDRESS ?? DEFAULT_PAYEE)
  const app = createApp({ lens, payTo, price: o.price, facilitator: o.facilitator, chain: client })
  const host = o.host ?? '127.0.0.1'
  const server = serve({ fetch: app.fetch, port: o.port ?? 0, hostname: host })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const port = (server.address() as { port: number }).port
  return {
    app,
    url: `http://${host}:${port}`,
    port,
    payTo,
    lens,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ('closeAllConnections' in server) server.closeAllConnections()
      }),
  }
}
