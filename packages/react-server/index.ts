import { createServer } from 'node:http'

import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

export async function startReactServer(loadApi: () => Promise<{ api: Hono }>, defaultPort: number) {
    const development = process.argv.includes('--dev')
    process.env.NODE_ENV ??= development ? 'development' : 'production'

    const { api } = await loadApi()
    const handleApi = getRequestListener(api.fetch)
    const server = createServer()
    const vite = development ? await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: { server } } }) : undefined

    if (!vite) {
        api.get('*', serveStatic({ root: './dist' }))
        api.get('*', serveStatic({ path: './dist/index.html' }))
    }

    server.on('request', (request, response) => {
        const pathname = request.url?.split('?')[0]
        if (vite && pathname !== '/api' && !pathname?.startsWith('/api/')) {
            vite.middlewares(request, response)
            return
        }
        void handleApi(request, response)
    })

    const port = Number(process.env.PORT || defaultPort)
    const host = process.env.HOST || '0.0.0.0'
    server.listen(port, host, () => {
        process.stdout.write(`Listening at http://${host}:${port}\n`)
    })
}
