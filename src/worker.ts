// Cloudflare Worker entry: `main` in wrangler.toml. The Worker's app is in worker-app.ts; this file may export only the handler.
import { workerFor, type Env } from './worker-app.ts'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let app
    try {
      app = workerFor(env)
    } catch (e) {
      return Response.json({ error: 'the Worker is misconfigured', detail: (e as Error).message }, { status: 500 })
    }
    return app.fetch(request)
  },
}
