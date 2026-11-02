import type { Server } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { compact } from '../core/compact.js'
import logger from '../logger.js'
import {
  elements,
  files,
  type InitialElementsMessage,
  type SyncStatusMessage,
  type WebSocketMessage,
} from '../types.js'
import { currentProject } from './boards.js'

// WebSocket connections
export const clients = new Set<WebSocket>()

// The whole scene, for a tab that connects, reloads or switches board.
export function sceneMessage(): InitialElementsMessage {
  return {
    type: 'initial_elements',
    elements: Array.from(elements.values(), compact),
    project: currentProject(),
    // ids only: a tab keeps each image (IndexedDB) and gets a missing one from /api/files/:id
    fileIds: [...files.keys()],
  }
}

// Tabs that pull their scene by delta (/api/projects/scene, ws ?scene=pull): no full scene on connect or switch
const pulls = new WeakSet<WebSocket>()

// The whole scene to every tab that does not pull it.
export function broadcastScene(): void {
  const data = JSON.stringify(sceneMessage())
  for (const client of clients) if (!pulls.has(client) && client.readyState === WebSocket.OPEN) client.send(data)
}

// Broadcast to all connected clients
export function broadcast(message: WebSocketMessage): void {
  const data = JSON.stringify(message)
  clients.forEach(client => {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    } catch {
      logger.warn('Failed to send to client, removing')
      clients.delete(client)
    }
  })
}

// The ping loop and the connection handler, on the http server the app listens on.
export function attachWebSockets(server: Server): void {
  const wss = new WebSocketServer({ server, perMessageDeflate: { threshold: 1024 } })
  // WebSocket connection handling
  // Ping every 25s. A link with no traffic through the tunnel stays open, and a client with no pong is dropped.
  const ponged = new WeakMap<WebSocket, boolean>()
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ponged.get(ws) === false) {
        ws.terminate()
        continue
      }
      ponged.set(ws, false)
      ws.ping()
    }
  }, 25_000).unref()

  wss.on('connection', (ws: WebSocket, req) => {
    clients.add(ws)
    const pull = new URL(req.url ?? '/', 'http://x').searchParams.get('scene') === 'pull'
    if (pull) pulls.add(ws)
    ponged.set(ws, true)
    ws.on('pong', () => ponged.set(ws, true))
    logger.info('New WebSocket connection established')

    // Send current elements to new client; a pulling tab asks for its delta itself
    if (!pull) ws.send(JSON.stringify(sceneMessage()))

    // Send sync status to new client
    const syncMessage: SyncStatusMessage = {
      type: 'sync_status',
      elementCount: elements.size,
      timestamp: new Date().toISOString(),
    }
    ws.send(JSON.stringify(syncMessage))

    ws.on('close', () => {
      clients.delete(ws)
      logger.info('WebSocket connection closed')
    })

    ws.on('error', error => {
      logger.error('WebSocket error:', error)
      clients.delete(ws)
    })
  })
}
