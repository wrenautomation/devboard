import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import {
  acquireDurableStateLock,
  durableStatePath,
  loadDurableState,
  releaseDurableStateLock,
} from './core/canvas-persistence.js'
import { isMainModule } from './core/entry.js'
import { removePidFile, writePidFile } from './core/pidfile.js'
import { mountElements } from './server/elements.js'
import { mountExport } from './server/export.js'
import { mountFiles } from './server/files.js'
import { mountNotes } from './server/notes.js'
import { mountProjects } from './server/projects.js'
import { fail } from './server/reply.js'
import { mountSnapshots } from './server/snapshots.js'
import { mountViewport } from './server/viewport.js'
import { attachWebSockets, clients } from './server/ws.js'
import { elements } from './types.js'
import logger from './utils/logger.js'

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = createServer(app)

// Middleware
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist')
app.use(express.static(staticDir))
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')))
// Serve Excalidraw fonts so the font subsetting worker can fetch them for export
app.use('/assets/fonts', express.static(path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')))

attachWebSockets(server)

// Routes, in the order they were registered when they all sat in this file.
mountElements(app)
mountFiles(app)
mountExport(app)
mountViewport(app)
mountSnapshots(app)

// Serve the frontend
app.get('/', (_req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html')
  res.sendFile(htmlFile, err => {
    if (err) {
      logger.error('Error serving frontend:', err)
      res.status(404).send('Frontend not found. Please run "npm run build" first.')
    }
  })
})

mountNotes(app)
mountProjects(app)

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    elements_count: elements.size,
    websocket_clients: clients.size,
    // Image renderers available right now: headless (always, in-process) and
    // the number of browser tabs that can render on request
    renderers: { node: true, browser: clients.size },
    ...(durableStatePath() ? { durable_state_enabled: true } : {}),
    // Identity for `stop`: it must only ever signal a process that both
    // identifies as this service AND self-reports its pid — never a pid
    // from a stale pidfile or an unrelated app squatting on the port.
    service: 'mcp-excalidraw-canvas',
    pid: process.pid,
  })
})

// Sync status endpoint
app.get('/api/sync/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    elementCount: elements.size,
    ...(durableStatePath() ? { durableStateEnabled: true } : {}),
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: clients.size,
  })
})

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err)
  fail(res, 500, 'Internal server error')
})

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '127.0.0.1'
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1']

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const socket = net.createConnection({ host, port })

    const finish = (isOpen: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(isOpen)
    }

    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) {
      return host
    }
  }
  return null
}

function releaseDurableStateLockSafely(): void {
  try {
    releaseDurableStateLock()
  } catch (error) {
    logger.error('Failed to release canvas data-directory lock:', error)
  }
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`)
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`)
  } else {
    logger.error('Failed to start canvas server:', error)
  }
  releaseDurableStateLockSafely()
  process.exit(1)
})

async function startServer(): Promise<void> {
  acquireDurableStateLock()
  let durableState: ReturnType<typeof loadDurableState>
  try {
    durableState = loadDurableState()
  } catch (error) {
    releaseDurableStateLockSafely()
    throw error
  }

  if (durableState.loaded) {
    logger.info('Loaded durable canvas state', {
      elements: durableState.elements,
      files: durableState.files,
      snapshots: durableState.snapshots,
    })
  } else if (durableState.enabled) {
    logger.info('Durable canvas state enabled; starting without an existing checkpoint')
  }

  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT)
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
          `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
          'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.',
      )
      releaseDurableStateLockSafely()
      process.exit(1)
    }
  }

  // The pidfile identifies the listening process for CLI lifecycle commands.
  // The data-directory lock independently protects durable-state ownership.
  let ownsPidFile = false

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST)
    logger.info(`POC server running on http://${hostForUrl}:${PORT}`)
    logger.info(`WebSocket server running on ws://${hostForUrl}:${PORT}`)

    // Written only after listen succeeds so stale files can't shadow a
    // server that never came up; lets `excalidraw-canvas stop` find us.
    writePidFile(PORT, process.pid)
    ownsPidFile = true
  })

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}, shutting down canvas server`)
    if (ownsPidFile) removePidFile(PORT)
    server.close(() => {
      releaseDurableStateLockSafely()
      process.exit(0)
    })
    // Force-exit if open sockets keep the server from closing promptly.
    setTimeout(() => {
      releaseDurableStateLockSafely()
      process.exit(0)
    }, 2000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('exit', () => {
    if (ownsPidFile) removePidFile(PORT)
    releaseDurableStateLockSafely()
  })
}

// Start the canvas server only when this file is the process entry point
// (`node dist/server.js`, `npm run canvas`, or spawned by the CLI/MCP
// auto-start). Importing this module must never start the server.
if (isMainModule(import.meta.url)) {
  void startServer().catch(error => {
    logger.error('Failed to start canvas server:', error)
    releaseDurableStateLockSafely()
    process.exit(1)
  })
}

export { startServer }
export default app
