import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { WebSocketServer } from 'ws'
import { registerClient, unregisterClient } from './lib/ws-broadcaster.js'
import { startWatchingPlan, startPoller } from './lib/mcp-poller.js'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOST ?? 'localhost'
const port = parseInt(process.env.PORT ?? '3000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

console.log(`> Starting Conductor web (${dev ? 'dev' : 'production'}) on http://${hostname}:${port}`)

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Request error:', err)
      res.statusCode = 500
      res.end('Internal server error\n\n' + String(err) + '\n\n' + (err instanceof Error ? err.stack ?? '' : ''))
    }
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url!)
    const match = pathname?.match(/^\/api\/plans\/([^/]+)\/ws$/)
    if (!match) {
      socket.destroy()
      return
    }
    const planId = match[1]
    wss.handleUpgrade(req, socket, head, (ws) => {
      registerClient(planId, ws)
      startWatchingPlan(planId)
      ws.on('close', () => unregisterClient(planId, ws))
      ws.on('error', () => unregisterClient(planId, ws))
    })
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`)
    startPoller()
  })
}).catch((err) => {
  console.error('> Failed to start server:', err)
  process.exit(1)
})
