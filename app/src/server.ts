import { execFileSync } from 'node:child_process'
import * as projectFs from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import {
  acquireDurableStateLock,
  CanvasFileImmutabilityError,
  CanvasFileReferenceError,
  CanvasPersistenceError,
  commitCanvasMutation,
  durableStatePath,
  loadDurableState,
  moveDurableDirectory,
  releaseDurableStateLock,
  switchDurableDirectory,
} from './core/canvas-persistence.js'
import { isMainModule } from './core/entry.js'
import { normalizePoints } from './core/normalize.js'
import { removePidFile, writePidFile } from './core/pidfile.js'
import { MAX_SCALE, RenderError, renderScene } from './core/render/index.js'
import {
  type BatchCreatedMessage,
  type ElementCreatedMessage,
  type ElementDeletedMessage,
  type ElementUpdatedMessage,
  EXCALIDRAW_ELEMENT_TYPES,
  type ExcalidrawElementType,
  type ExcalidrawFile,
  elements,
  files,
  generateId,
  type InitialElementsMessage,
  normalizeFontFamily,
  type ServerElement,
  type Snapshot,
  type SyncStatusMessage,
  snapshots,
  type WebSocketMessage,
} from './types.js'
import logger from './utils/logger.js'

function mutationErrorStatus(error: unknown, fallback: number): number {
  if (error instanceof CanvasPersistenceError) return 500
  if (error instanceof CanvasFileImmutabilityError || error instanceof CanvasFileReferenceError) return 409
  return fallback
}

// Load environment variables
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

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

// WebSocket connections
const clients = new Set<WebSocket>()

// Broadcast to all connected clients
function broadcast(message: WebSocketMessage): void {
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

function normalizeLineBreakMarkup(text: string): string {
  return text.replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n').replace(/\n{3,}/g, '\n\n')
}

function prepareFileWrites(fileList: unknown[]): ExcalidrawFile[] {
  const durable = Boolean(durableStatePath())

  // Preserve the pre-persistence endpoint exactly when durability is disabled:
  // valid entries overwrite in request order, omitted metadata uses the same
  // truthy defaults, and an existing file contributes no implicit defaults.
  if (!durable) {
    const prepared: ExcalidrawFile[] = []
    for (const value of fileList) {
      if (value === null || typeof value !== 'object') continue
      const candidate = value as Partial<ExcalidrawFile>
      if (!candidate.id || !candidate.dataURL) continue
      prepared.push({
        id: candidate.id,
        dataURL: candidate.dataURL,
        mimeType: candidate.mimeType || 'image/png',
        created: candidate.created || Date.now(),
      })
    }
    return prepared
  }

  const prepared = new Map<string, ExcalidrawFile>()

  for (const value of fileList) {
    if (value === null || typeof value !== 'object') continue
    const candidate = value as Partial<ExcalidrawFile>
    if (
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      typeof candidate.dataURL !== 'string' ||
      candidate.dataURL.length === 0
    ) {
      continue
    }

    const previous = prepared.get(candidate.id) ?? files.get(candidate.id)
    const mimeType =
      typeof candidate.mimeType === 'string' && candidate.mimeType.length > 0
        ? candidate.mimeType
        : (previous?.mimeType ?? 'image/png')

    if (previous) {
      if (previous.dataURL !== candidate.dataURL || previous.mimeType !== mimeType) {
        throw new CanvasFileImmutabilityError(candidate.id)
      }
      prepared.set(candidate.id, previous)
      continue
    }

    prepared.set(candidate.id, {
      id: candidate.id,
      dataURL: candidate.dataURL,
      mimeType,
      // Preserve the original in-memory endpoint's overwrite behavior:
      // an omitted/zero timestamp is replaced with the current time. Durable
      // retries of an existing immutable id returned above keep prior metadata.
      created:
        typeof candidate.created === 'number' && Number.isFinite(candidate.created) && candidate.created > 0
          ? candidate.created
          : Date.now(),
    })
  }

  return [...prepared.values()]
}

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

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws)
  ponged.set(ws, true)
  ws.on('pong', () => ponged.set(ws, true))
  logger.info('New WebSocket connection established')

  // Send current elements to new client
  const filesObj: Record<string, ExcalidrawFile> = {}
  files.forEach((f, id) => {
    filesObj[id] = f
  })
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: Array.from(elements.values()),
    project: currentProject(),
    ...(files.size > 0 ? { files: filesObj } : {}),
  }
  ws.send(JSON.stringify(initialMessage))

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

// Schema validation
const CreateElementSchema = z
  .object({
    id: z.string().optional(), // Allow passing ID for MCP sync
    type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
    x: z.number(),
    y: z.number(),
    width: z.number().optional(),
    height: z.number().optional(),
    backgroundColor: z.string().optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().optional(),
    strokeStyle: z.string().optional(),
    roughness: z.number().optional(),
    opacity: z.number().optional(),
    text: z.string().optional(),
    label: z
      .object({
        text: z.string(),
      })
      .optional(),
    fontSize: z.number().optional(),
    fontFamily: z.union([z.string(), z.number()]).optional(),
    // Bound-text back-pointer — without it, zod strips containerId on import
    // and re-imported bound labels detach from their containers
    containerId: z.string().nullable().optional(),
    // Excalidraw identity fields — preserve through import so re-exported
    // scenes keep their stacking order, roughness seeds, and timestamps, and
    // no-op import→export cycles stay byte-stable
    index: z.string().nullable().optional(),
    seed: z.number().optional(),
    versionNonce: z.number().optional(),
    updated: z.number().optional(),
    groupIds: z.array(z.string()).optional(),
    locked: z.boolean().optional(),
    roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
    fillStyle: z.string().optional(),
    // Arrow-specific properties
    points: z.any().optional(),
    start: z.object({ id: z.string() }).optional(),
    end: z.object({ id: z.string() }).optional(),
    startArrowhead: z.string().nullable().optional(),
    endArrowhead: z.string().nullable().optional(),
    elbowed: z.boolean().optional(),
    // Arrow binding properties (preserved for Excalidraw frontend)
    startBinding: z
      .object({
        elementId: z.string(),
        focus: z.number().optional(),
        gap: z.number().optional(),
        fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
        mode: z.string().optional(),
      })
      .nullable()
      .optional(),
    endBinding: z
      .object({
        elementId: z.string(),
        focus: z.number().optional(),
        gap: z.number().optional(),
        fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
        mode: z.string().optional(),
      })
      .nullable()
      .optional(),
    boundElements: z
      .array(
        z.object({
          id: z.string(),
          type: z.enum(['arrow', 'text']),
        }),
      )
      .nullable()
      .optional(),
    // Image-specific properties
    fileId: z.string().optional(),
    status: z.string().optional(),
    scale: z.tuple([z.number(), z.number()]).optional(),
  })
  .passthrough()

const UpdateElementSchema = z
  .object({
    id: z.string(),
    type: z
      .enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]])
      .optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    backgroundColor: z.string().optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().optional(),
    strokeStyle: z.string().optional(),
    roughness: z.number().optional(),
    opacity: z.number().optional(),
    text: z.string().optional(),
    originalText: z.string().optional(),
    label: z
      .object({
        text: z.string(),
      })
      .optional(),
    fontSize: z.number().optional(),
    fontFamily: z.union([z.string(), z.number()]).optional(),
    // Bound-text back-pointer — without it, zod strips containerId on import
    // and re-imported bound labels detach from their containers
    containerId: z.string().nullable().optional(),
    // Excalidraw identity fields — preserve through import so re-exported
    // scenes keep their stacking order, roughness seeds, and timestamps, and
    // no-op import→export cycles stay byte-stable
    index: z.string().nullable().optional(),
    seed: z.number().optional(),
    versionNonce: z.number().optional(),
    updated: z.number().optional(),
    groupIds: z.array(z.string()).optional(),
    locked: z.boolean().optional(),
    roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
    fillStyle: z.string().optional(),
    points: z
      .array(z.union([z.tuple([z.number(), z.number()]), z.object({ x: z.number(), y: z.number() })]))
      .optional(),
    start: z.object({ id: z.string() }).optional(),
    end: z.object({ id: z.string() }).optional(),
    startArrowhead: z.string().nullable().optional(),
    endArrowhead: z.string().nullable().optional(),
    elbowed: z.boolean().optional(),
    // Arrow binding properties (preserved for Excalidraw frontend)
    startBinding: z
      .object({
        elementId: z.string(),
        focus: z.number().optional(),
        gap: z.number().optional(),
        fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
        mode: z.string().optional(),
      })
      .nullable()
      .optional(),
    endBinding: z
      .object({
        elementId: z.string(),
        focus: z.number().optional(),
        gap: z.number().optional(),
        fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
        mode: z.string().optional(),
      })
      .nullable()
      .optional(),
    boundElements: z
      .array(
        z.object({
          id: z.string(),
          type: z.enum(['arrow', 'text']),
        }),
      )
      .nullable()
      .optional(),
    // Image-specific properties
    fileId: z.string().optional(),
    status: z.string().optional(),
    scale: z.tuple([z.number(), z.number()]).optional(),
  })
  .passthrough()

// Local patch: scratch areas. A frame named "Scratch…" holds rough work that must never reach a model.
// Agents (CLI, MCP, curl) never see what is inside one; only the canvas tab (header x-devboard-tab: 1) does.
// The frame itself stays visible, so an agent knows not to draw there, but an agent cannot move or delete it.
const SCRATCH_NAME = /^scratch/i
const isTab = (req: Request) => req.get('x-devboard-tab') === '1'
// Every server-side write is an edit: a new versionNonce with each version, so Excalidraw's tie-break
// (same version, lower nonce wins) stays fair between the server and the tabs.
const freshNonce = () => Math.floor(Math.random() * 2 ** 31)
const isScratchFrame = (e: ServerElement | undefined) =>
  !!e && e.type === 'frame' && SCRATCH_NAME.test(String(e.name ?? ''))
function scratchHidden(): Set<string> {
  const all = Array.from(elements.values())
  const frames = all.filter(isScratchFrame)
  const hidden = new Set<string>()
  if (!frames.length) return hidden
  const frameIds = new Set(frames.map(f => f.id))
  // Inside = assigned to the frame, or centre inside it (Excalidraw assigns only shapes drawn fully inside).
  const inside = (e: ServerElement) => {
    const cx = e.x + (e.width ?? 0) / 2,
      cy = e.y + (e.height ?? 0) / 2
    return frames.some(f => cx >= f.x && cx <= f.x + (f.width ?? 0) && cy >= f.y && cy <= f.y + (f.height ?? 0))
  }
  for (const e of all) {
    if (!frameIds.has(e.id) && ((e.frameId && frameIds.has(e.frameId)) || inside(e))) hidden.add(e.id)
  }
  for (const e of all) if (e.containerId && hidden.has(e.containerId)) hidden.add(e.id)
  return hidden
}
function visibleTo<T extends { id: string }>(req: Request, list: T[]): T[] {
  if (isTab(req)) return list
  const hidden = scratchHidden()
  return hidden.size ? list.filter(e => !hidden.has(e.id)) : list
}
// An agent may not read, change or delete scratch work, nor move or delete a scratch frame.
function scratchBlock(req: Request, res: Response, id: string, write: boolean): boolean {
  if (isTab(req)) return false
  if (scratchHidden().has(id)) {
    res.status(404).json({ success: false, error: `Element with ID ${id} not found` })
    return true
  }
  if (write && isScratchFrame(elements.get(id))) {
    res.status(403).json({ success: false, error: 'This is a scratch area. Only William changes it.' })
    return true
  }
  return false
}

// API Routes

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const elementsArray = visibleTo(req, Array.from(elements.values()))
    // The board name comes with its scene, so a tab that missed a switch never merges into the wrong one.
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length,
      project: currentProject(),
    })
  } catch (error) {
    logger.error('Error fetching elements:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const params = CreateElementSchema.parse(req.body)
    logger.info('Creating element via API', { type: params.type })

    // Prioritize passed ID (for MCP sync), otherwise generate new ID
    const id = params.id || generateId()
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      versionNonce: freshNonce(),
    }

    // Resolve arrow bindings against existing elements
    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings([element])
    }

    commitCanvasMutation(() => elements.set(id, element))

    // Broadcast to all connected clients
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element,
    }
    broadcast(message)

    res.json({
      success: true,
      element: element,
    })
  } catch (error) {
    logger.error('Error creating element:', error)
    res.status(mutationErrorStatus(error, 400)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const updates = UpdateElementSchema.parse({ id, ...body })
    if (id && scratchBlock(req, res, id, true)) return

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required',
      })
    }

    const existingElement = elements.get(id)
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`,
      })
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      // Points come as [x, y] tuples or {x, y}; the canvas stores tuples.
      points: updates.points ? normalizePoints(updates.points) : existingElement.points,
      fontFamily:
        updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1,
      versionNonce: freshNonce(),
    }

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.hasOwn(body, 'text')
    const hasOriginalTextUpdate = Object.hasOwn(body, 'originalText')
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? ''
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : ''
      const existingOriginalText = typeof existingElement.originalText === 'string' ? existingElement.originalText : ''
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText)
      const normalizedExistingText = normalizeLineBreakMarkup(existingText)
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText)

      // Handle common cleanup flow: caller normalizes the rendered text value.
      // In this case, prefer normalized originalText so words aren't split by stale wraps.
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText
        updatedElement.originalText = normalizedExistingOriginalText
      } else {
        updatedElement.originalText = incomingText
      }
    }

    // Moving/resizing a shape must drag its bound arrows along. Keep the
    // element update and every in-place arrow reroute in one durable mutation.
    const geometryChanged = ['x', 'y', 'width', 'height'].some(key => Object.hasOwn(body, key))
    const reroutedArrows = commitCanvasMutation(() => {
      elements.set(id, updatedElement)
      return geometryChanged && updatedElement.type !== 'arrow' && updatedElement.type !== 'line'
        ? rerouteBoundArrows(id)
        : []
    })

    // Publish only after the complete mutation has been checkpointed.
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement,
    }
    broadcast(message)
    for (const arrow of reroutedArrows) {
      broadcast({ type: 'element_updated', element: arrow } as ElementUpdatedMessage)
    }

    res.json({
      success: true,
      element: updatedElement,
    })
  } catch (error) {
    logger.error('Error updating element:', error)
    res.status(mutationErrorStatus(error, 400)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    // An agent's clear keeps scratch frames and their contents.
    const hidden = isTab(req) ? new Set<string>() : scratchHidden()
    const kept = isTab(req) ? [] : Array.from(elements.values()).filter(e => hidden.has(e.id) || isScratchFrame(e))
    const count = elements.size - kept.length
    commitCanvasMutation(() => {
      elements.clear()
      for (const e of kept) elements.set(e.id, e)
    })

    broadcast({
      type: 'canvas_cleared',
      timestamp: new Date().toISOString(),
    })
    if (kept.length) broadcast({ type: 'elements_batch_created', elements: kept } as BatchCreatedMessage)

    logger.info(`Canvas cleared: ${count} elements removed`)

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count,
    })
  } catch (error) {
    logger.error('Error clearing canvas:', error)
    res.status(mutationErrorStatus(error, 500)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required',
      })
    }

    if (!elements.has(id)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`,
      })
    }
    if (scratchBlock(req, res, id, true)) return

    commitCanvasMutation(() => elements.delete(id))

    // Broadcast to all connected clients
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id,
    }
    broadcast(message)

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`,
    })
  } catch (error) {
    logger.error('Error deleting element:', error)
    res.status(mutationErrorStatus(error, 500)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const { type, x_min, x_max, y_min, y_max, ...filters } = req.query
    let results = visibleTo(req, Array.from(elements.values()))

    // Filter by type if specified
    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type)
    }

    // Filter by bounding box if specified
    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity
      const xMax = x_max !== undefined ? Number(x_max) : Infinity
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity
      const yMax = y_max !== undefined ? Number(y_max) : Infinity

      results = results.filter(el => el.x >= xMin && el.x <= xMax && el.y >= yMin && el.y <= yMax)
    }

    // Apply additional exact-match filters
    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return element[key] === value
        })
      })
    }

    res.json({
      success: true,
      elements: results,
      count: results.length,
    })
  } catch (error) {
    logger.error('Error querying elements:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required',
      })
    }

    const element = elements.get(id)

    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`,
      })
    }
    if (scratchBlock(req, res, id, false)) return

    res.json({
      success: true,
      element: element,
    })
  } catch (error) {
    logger.error('Error fetching element:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(el: ServerElement, targetCenterX: number, targetCenterY: number): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2
  const cy = el.y + (el.height || 0) / 2
  const dx = targetCenterX - cx
  const dy = targetCenterY - cy

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2
    const hh = (el.height || 0) / 2
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh }
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    // Scale factor to reach diamond edge
    const scale = absDx / hw + absDy / hh > 0 ? 1 / (absDx / hw + absDy / hh) : 1
    return { x: cx + dx * scale, y: cy + dy * scale }
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2
    const b = (el.height || 0) / 2
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b }
    const angle = Math.atan2(dy, dx)
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) }
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2
  const hh = (el.height || 0) / 2
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh }
  const angle = Math.atan2(dy, dx)
  const tanA = Math.tan(angle)
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1
    return { x: cx + signX * hw, y: cy + signX * hw * tanA }
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1
    return { x: cx + (signY * hh) / tanA, y: cy + signY * hh }
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(batchElements: ServerElement[], includeExisting = true): void {
  const elementMap = new Map<string, ServerElement>()
  for (const el of batchElements) elementMap.set(el.id, el)

  // Also check existing elements for cross-batch references
  if (includeExisting) {
    elements.forEach((el, id) => {
      if (!elementMap.has(id)) elementMap.set(id, el)
    })
  }

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue
    const startRef = el.start
    const endRef = el.end

    if (!startRef && !endRef) continue

    const startEl = startRef ? elementMap.get(startRef.id) : undefined
    const endEl = endRef ? elementMap.get(endRef.id) : undefined

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y }
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y }

    const GAP = 8
    const startPt = startEl ? computeEdgePoint(startEl, endCenter.x, endCenter.y) : startCenter
    const endPt = endEl ? computeEdgePoint(endEl, startCenter.x, startCenter.y) : endCenter

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x
    const startDy = endPt.y - startPt.y
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1
    const endDx = startPt.x - endPt.x
    const endDy = startPt.y - endPt.y
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP,
    }
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP,
    }

    // Set arrow position and points
    el.x = finalStart.x
    el.y = finalStart.y
    el.points = [
      [0, 0],
      [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y],
    ]

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// After a shape's geometry changes, recompute every arrow bound to it so the
// visual connection follows the shape — bindings are otherwise only resolved
// at creation time, which left arrows floating at stale coordinates when
// update/align/distribute moved their endpoints. Returns the re-routed arrows.
function rerouteBoundArrows(movedId: string): ServerElement[] {
  const rerouted: ServerElement[] = []
  elements.forEach(el => {
    if (el.type !== 'arrow' && el.type !== 'line') return
    if (el.start?.id !== movedId && el.end?.id !== movedId) return
    resolveArrowBindings([el])
    el.updatedAt = new Date().toISOString()
    el.version = (el.version || 0) + 1
    el.versionNonce = freshNonce()
    rerouted.push(el)
  })
  return rerouted
}

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  try {
    const { elements: elementsToCreate, replace = false } = req.body ?? {}

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements',
      })
    }
    if (typeof replace !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'replace must be a boolean',
      })
    }

    const createdElements: ServerElement[] = []

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData)
      // Prioritize passed ID (for MCP sync), otherwise generate new ID
      const id = params.id || generateId()
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        versionNonce: freshNonce(),
      }

      createdElements.push(element)
    })

    // Fully prepare the batch before mutating storage. Replacement imports do
    // not resolve bindings against elements that are about to be discarded.
    resolveArrowBindings(createdElements, !replace)

    // An agent's replace keeps scratch frames and their contents.
    const hidden = replace && !isTab(req) ? scratchHidden() : new Set<string>()
    const kept =
      replace && !isTab(req) ? Array.from(elements.values()).filter(e => hidden.has(e.id) || isScratchFrame(e)) : []
    const replacedCount = replace ? elements.size - kept.length : 0
    commitCanvasMutation(() => {
      if (replace) {
        elements.clear()
        for (const e of kept) elements.set(e.id, e)
      }
      for (const el of createdElements) elements.set(el.id, el)
    })

    // Publish only after clear + replacement have reached one checkpoint.
    if (replace) {
      broadcast({
        type: 'canvas_cleared',
        timestamp: new Date().toISOString(),
      })
      logger.info(`Canvas replaced: ${replacedCount} existing elements removed`)
    }

    // Broadcast to all connected clients
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: [...kept.filter(e => !createdElements.some(c => c.id === e.id)), ...createdElements],
    }
    broadcast(message)

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length,
    })
  } catch (error) {
    logger.error('Error batch creating elements:', error)
    res.status(mutationErrorStatus(error, 400)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const { mermaidDiagram, config } = req.body

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required',
      })
    }

    logger.info('Received Mermaid conversion request', {
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config,
    })

    // Broadcast to all WebSocket clients to process the Mermaid diagram
    broadcast({
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString(),
    })

    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.',
    })
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error)
    res.status(400).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Sync elements from frontend (overwrite sync)
app.post('/api/elements/sync', (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const { elements: frontendElements, timestamp } = body

    // A save is an overwrite. A tab still showing another project must never write into this one.
    const forProject = req.header('x-canvas-project')
    if (PROJECTS_DIR && CURRENT_FILE && forProject && forProject !== currentProject()) {
      logger.warn(`Refused sync for "${forProject}": open project is "${currentProject()}"`)
      return res.status(409).json({ success: false, error: 'project_changed', current: currentProject() })
    }

    // Validate input data
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array',
      })
    }

    logger.info(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length,
    })

    // Record element count before sync
    const beforeCount = elements.size
    let successCount = 0
    const processedElements: ServerElement[] = []

    // A sync that is not from the canvas tab keeps scratch frames and their contents.
    const hidden = isTab(req) ? new Set<string>() : scratchHidden()
    const kept = isTab(req) ? [] : Array.from(elements.values()).filter(e => hidden.has(e.id) || isScratchFrame(e))
    commitCanvasMutation(() => {
      elements.clear()
      for (const e of kept) elements.set(e.id, e)
      frontendElements.forEach((element: ServerElement, index: number) => {
        try {
          // Ensure element has ID, generate one if missing
          const elementId = element.id || generateId()

          // Add server metadata
          const processedElement: ServerElement = {
            ...element,
            id: elementId,
            syncedAt: new Date().toISOString(),
            source: 'frontend_sync',
            syncTimestamp: timestamp,
            version: element.version || 1,
          }

          elements.set(elementId, processedElement)
          processedElements.push(processedElement)
          successCount++
        } catch (elementError) {
          logger.warn(`Failed to process element ${index}:`, elementError)
        }
      })
    })

    logger.info(`Cleared existing elements: ${beforeCount} elements removed`)
    logger.info(`Sync completed: ${successCount}/${frontendElements.length} elements synced`)

    // 3. Broadcast sync event to all WebSocket clients
    broadcast({
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync',
    })

    // 4. Return sync results
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: elements.size,
    })
  } catch (error) {
    logger.error('Sync error:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation',
    })
  }
})

// Merge push from a tab: only the shapes it changed, deletes included (isDeleted). Excalidraw's rule
// picks the winner per shape: the higher version, then the lower versionNonce. The same push sent twice
// is a no-op, so a tab can retry after a lost reply. The losers come back so the tab can take them.
type PushedElement = ServerElement & { version: number }
const isPushedElement = (e: unknown): e is PushedElement =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as PushedElement).id === 'string' &&
  Number.isFinite((e as PushedElement).version)
app.post('/api/elements/push', (req: Request, res: Response) => {
  try {
    const forProject = req.header('x-canvas-project')
    if (PROJECTS_DIR && CURRENT_FILE && forProject && forProject !== currentProject()) {
      return res.status(409).json({ success: false, error: 'project_changed', current: currentProject() })
    }
    const incoming: unknown = req.body?.elements
    if (!Array.isArray(incoming) || !incoming.every(isPushedElement)) {
      return res.status(400).json({ success: false, error: 'Expected elements with id and version' })
    }
    const applied: { id: string; version: number; versionNonce: number }[] = []
    const rejected: ServerElement[] = []
    const changed: ServerElement[] = []
    commitCanvasMutation(() => {
      for (const el of incoming) {
        const cur = elements.get(el.id)
        const nonce = (e: { versionNonce?: number }) => e.versionNonce ?? 0
        const curVersion = cur?.version ?? 0 // every stored element carries one
        const same = cur && curVersion === el.version && nonce(cur) === nonce(el)
        const wins = !cur || el.version > curVersion || (el.version === curVersion && nonce(el) < nonce(cur))
        if (!same && !wins) {
          rejected.push(cur)
          continue
        }
        applied.push({ id: el.id, version: el.version, versionNonce: nonce(el) })
        if (same) continue
        if (el.isDeleted) {
          if (cur) {
            elements.delete(el.id)
            changed.push(el)
          }
          continue
        }
        const next: ServerElement = { ...el, syncedAt: new Date().toISOString(), source: 'frontend_push' }
        elements.set(el.id, next)
        changed.push(next)
        // A real label now exists: the container drops its skeleton label, or the next load makes it twice.
        const box = el.type === 'text' && el.containerId ? elements.get(el.containerId) : undefined
        if (box?.label) {
          const { label: _label, ...rest } = box
          elements.set(box.id, rest)
          changed.push(rest)
        }
      }
    })
    // Deletes go out as the deleted element, so each tab can weigh its version like any edit.
    if (changed.length) broadcast({ type: 'elements_merged', elements: changed })
    res.json({ success: true, applied, rejected })
  } catch (error) {
    logger.error('Push error:', error)
    res.status(mutationErrorStatus(error, 500)).json({ success: false, error: (error as Error).message })
  }
})

// ─── Files API (for image elements) ───────────────────────────
// GET all files
app.get('/api/files', (_req: Request, res: Response) => {
  const filesObj: Record<string, ExcalidrawFile> = {}
  files.forEach((f, id) => {
    filesObj[id] = f
  })
  res.json({ files: filesObj })
})

// POST add/update files (batch)
app.post('/api/files', (req: Request, res: Response) => {
  try {
    const body = req.body
    // Keep the existing endpoint's accepted wrapper/array shapes and count
    // behavior. Durable mode adds publication guarantees without redefining
    // the memory-only request contract.
    const fileList = (Array.isArray(body) ? body : body?.files || []) as unknown[]
    const preparedFiles = prepareFileWrites(fileList)

    commitCanvasMutation(() => {
      for (const file of preparedFiles) files.set(file.id, file)
    })
    // Broadcast only after every referenced blob and the checkpoint are durable.
    broadcast({ type: 'files_added', files: fileList })
    res.json({ success: true, count: fileList.length })
  } catch (error) {
    logger.error('Error storing canvas files:', error)
    if (!durableStatePath()) throw error
    res.status(mutationErrorStatus(error, 400)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// DELETE a file
app.delete('/api/files/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string
    if (!files.has(id)) {
      return res.status(404).json({ success: false, error: `File with ID ${id} not found` })
    }
    commitCanvasMutation(() => files.delete(id))
    broadcast({ type: 'file_deleted', fileId: id })
    res.json({ success: true })
  } catch (error) {
    logger.error('Error deleting canvas file:', error)
    res.status(mutationErrorStatus(error, 500)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  collectionTimeout: ReturnType<typeof setTimeout> | null
  bestResult: { format: string; data: string } | null
}
const pendingExports = new Map<string, PendingExport>()

const exportImageSchema = z.object({
  format: z.enum(['png', 'svg']),
  background: z.boolean().optional(),
  renderer: z.enum(['auto', 'node', 'browser']).optional(),
  dark: z.boolean().optional(),
  scale: z.number().min(1).max(MAX_SCALE).optional(),
  padding: z.number().min(0).optional(),
  elementIds: z.array(z.string()).min(1).optional(),
  frameId: z.string().optional(),
  area: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(),
  embedScene: z.boolean().default(false),
  embedFonts: z.boolean().optional(),
})
type ExportImageBody = z.infer<typeof exportImageSchema>

const NO_BROWSER_TAB_ERROR = 'No frontend client connected. Open the canvas in a browser first.'

// Ask the open browser tab(s) to render — Excalidraw's own exporter in a real
// browser. Slower (re-sync + 3 s collection window) and needs a tab, but it
// is the reference rendering, so it stays available as renderer:'browser'.
function exportViaBrowserTab(options: ExportImageBody): Promise<{ format: string; data: string }> {
  const { format, background, renderer: _renderer, ...rest } = options
  const requestId = generateId()

  const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingExports.get(requestId)
      pendingExports.delete(requestId)
      // If we collected any result during the window, use it
      if (pending?.bestResult) {
        resolve(pending.bestResult)
      } else {
        reject(new Error('Export timed out after 30 seconds'))
      }
    }, 30000)

    pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null })
  })

  // Re-broadcast current elements so all connected clients (including stale ones)
  // sync to the canonical server state before exporting
  const filesObj: Record<string, ExcalidrawFile> = {}
  files.forEach((f, id) => {
    filesObj[id] = f
  })
  broadcast({
    type: 'initial_elements',
    elements: Array.from(elements.values()),
    project: currentProject(),
    ...(files.size > 0 ? { files: filesObj } : {}),
  } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> })

  // Give browsers time to process the reload before requesting export
  setTimeout(() => {
    broadcast({
      type: 'export_image_request',
      requestId,
      format,
      background: background ?? true,
      options: { background, ...rest },
    })
  }, 800)

  return exportPromise
}

app.post('/api/export/image', async (req: Request, res: Response) => {
  const parsed = exportImageSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.')
    return res.status(400).json({
      success: false,
      error:
        where === 'format'
          ? 'format must be "png" or "svg"'
          : `${where ? `${where}: ` : ''}${issue?.message ?? 'invalid request'}`,
    })
  }
  const options = parsed.data
  if (options.embedScene && options.format !== 'png') {
    return res.status(400).json({ success: false, error: 'embedScene is only supported for PNG exports' })
  }
  const renderer = options.renderer ?? 'auto'

  const respondBrowser = async () => {
    if (clients.size === 0) {
      return res.status(503).json({ success: false, error: NO_BROWSER_TAB_ERROR })
    }
    try {
      const result = await exportViaBrowserTab({ ...options, hide: [...scratchHidden()] } as ExportImageBody)
      res.json({ success: true, format: result.format, data: result.data, renderer: 'browser' })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  if (renderer === 'browser') return respondBrowser()

  try {
    const { renderer: _renderer, ...renderOptions } = options
    const scene = { elements: visibleTo(req, Array.from(elements.values())), files: Object.fromEntries(files) }
    const result = await renderScene(scene, renderOptions)
    res.json({
      success: true,
      format: result.format,
      data: result.data,
      renderer: 'node',
      width: result.width,
      height: result.height,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    })
  } catch (error) {
    if (error instanceof RenderError) {
      return res.status(error.status).json({ success: false, error: error.message })
    }
    logger.error('Headless image export failed:', error)
    if (renderer === 'auto' && clients.size > 0) {
      // The reference renderer is available; use it rather than fail
      logger.warn('Falling back to the browser tab for this export')
      return respondBrowser()
    }
    res.status(500).json({ success: false, error: (error as Error).message })
  }
})

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required',
      })
    }

    const pending = pendingExports.get(requestId)
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true })
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`)
      return res.json({ success: true })
    }

    // Keep the largest response (most complete canvas state wins)
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data }
    }

    // Start a short collection window on the first response, then resolve with best
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId)
        if (p?.bestResult) {
          clearTimeout(p.timeout)
          pendingExports.delete(requestId)
          p.resolve(p.bestResult)
        }
      }, 3000)
    }

    res.json({ success: true })
  } catch (error) {
    logger.error('Error processing export result:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
const pendingViewports = new Map<string, PendingViewport>()

const viewportRequestSchema = z
  .object({
    scrollToContent: z.boolean().optional(),
    scrollToElementIds: z.array(z.string().min(1)).min(1).optional(),
    viewportZoomFactor: z.number().positive().max(1).optional(),
    scrollToElementId: z.string().min(1).optional(),
    zoom: z.number().min(0.1).max(10).optional(),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  })
  .superRefine((params, ctx) => {
    const modes = [
      params.scrollToContent === true,
      params.scrollToElementIds !== undefined,
      params.scrollToElementId !== undefined,
      params.zoom !== undefined || params.offsetX !== undefined || params.offsetY !== undefined,
    ].filter(Boolean).length

    if (modes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Specify exactly one viewport mode: scrollToContent, scrollToElementIds, scrollToElementId, or manual zoom/offset',
      })
    }
    if (
      params.viewportZoomFactor !== undefined &&
      params.scrollToContent !== true &&
      params.scrollToElementIds === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['viewportZoomFactor'],
        message: 'viewportZoomFactor requires scrollToContent or scrollToElementIds',
      })
    }
  })

app.post('/api/viewport', (req: Request, res: Response) => {
  try {
    const { scrollToContent, scrollToElementIds, scrollToElementId, viewportZoomFactor, zoom, offsetX, offsetY } =
      viewportRequestSchema.parse(req.body)

    if (clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.',
      })
    }

    const requestId = generateId()

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId)
        reject(new Error('Viewport request timed out after 10 seconds'))
      }, 10000)

      pendingViewports.set(requestId, { resolve, reject, timeout })
    })

    broadcast({
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY,
    })

    viewportPromise
      .then(result => {
        res.json(result)
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message,
        })
      })
  } catch (error) {
    logger.error('Error initiating viewport change:', error)
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      success: false,
      error:
        error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : (error as Error).message,
    })
  }
})

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required',
      })
    }

    const pending = pendingViewports.get(requestId)
    if (!pending) {
      return res.json({ success: true })
    }

    if (error || success === false) {
      clearTimeout(pending.timeout)
      pendingViewports.delete(requestId)
      pending.reject(new Error(error || message || 'Viewport update failed'))
      return res.json({ success: true })
    }

    clearTimeout(pending.timeout)
    pendingViewports.delete(requestId)
    pending.resolve({ success: true, message: message || 'Viewport updated' })

    res.json({ success: true })
  } catch (error) {
    logger.error('Error processing viewport result:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const { name } = req.body

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required',
      })
    }

    const snapshot: Snapshot = {
      name,
      // Snapshots are historical values, not aliases to live mutable elements.
      // Bound-arrow rerouting mutates arrow objects in place. structuredClone
      // is available across the supported Node.js >=20 runtime range.
      elements: structuredClone(Array.from(elements.values())),
      createdAt: new Date().toISOString(),
    }

    commitCanvasMutation(() => snapshots.set(name, snapshot))
    logger.info(`Snapshot saved: "${name}" with ${snapshot.elements.length} elements`)

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt,
    })
  } catch (error) {
    logger.error('Error saving snapshot:', error)
    res.status(mutationErrorStatus(error, 500)).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Snapshots: list
app.get('/api/snapshots', (_req: Request, res: Response) => {
  try {
    const list = Array.from(snapshots.values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt,
    }))

    res.json({
      success: true,
      snapshots: list,
      count: list.length,
    })
  } catch (error) {
    logger.error('Error listing snapshots:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const { name = '' } = req.params
    const snapshot = snapshots.get(name)

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`,
      })
    }

    res.json({
      success: true,
      snapshot: { ...snapshot, elements: visibleTo(req, snapshot.elements) },
    })
  } catch (error) {
    logger.error('Error fetching snapshot:', error)
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    })
  }
})

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

// Health check endpoint
// Local patch: notes to Claude Code sessions. The canvas posts a note (text + the selected ids);
// `draw watch` holds GET /api/events open (Server-Sent Events) and prints one line per note.
// The last 200 notes stay in notes.jsonl, so a watcher that reconnects gets the ones it missed.
type Note = {
  id: number
  at: string
  project: string
  to: string
  text: string
  ids: string[]
  box?: { x: number; y: number; w: number; h: number }
  area?: true
  enter?: true
}
const NOTES_FILE =
  process.env.EXCALIDRAW_NOTES_FILE ??
  (process.env.EXCALIDRAW_CURRENT_FILE
    ? path.join(path.dirname(process.env.EXCALIDRAW_CURRENT_FILE), 'notes.jsonl')
    : undefined)
const notes: Note[] = (() => {
  if (!NOTES_FILE) return []
  try {
    return projectFs
      .readFileSync(NOTES_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .slice(-200)
  } catch {
    return []
  }
})()
const watchers = new Map<Response, string>()
const sendNote = (res: Response, n: Note) => res.write(`id: ${n.id}\ndata: ${JSON.stringify(n)}\n\n`)
const forWatcher = (n: Note, name: string) => !n.to || n.to === name
app.post('/api/notify', (req: Request, res: Response) => {
  const text = String(req.body?.text ?? '')
    .trim()
    .slice(0, 4000)
  const hidden = scratchHidden() // a note never points Claude at scratch work
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids
        .map(String)
        .filter((id: string) => !hidden.has(id))
        .slice(0, 500)
    : []
  const b = req.body?.box
  const box =
    b && [b.x, b.y, b.w, b.h].every(Number.isFinite)
      ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }
      : undefined
  // area: the box is a marked area, not the bounds of the selected shapes.
  const area = req.body?.area === true && box && box.w > 0 && box.h > 0
  if (!text && !ids.length && !area)
    return res.status(400).json({ success: false, error: 'note needs text, selected shapes or a marked area' })
  const to = WATCHER_NAME.test(String(req.body?.to ?? '')) ? String(req.body.to) : ''
  // enter: also press Enter in the terminal of that one session, so a message typed there goes in too.
  const shell = req.body?.enter === true && to ? liveSessions().find(x => x.watch === to)?.shell : undefined
  const note: Note = {
    id: Math.max(Date.now(), (notes.at(-1)?.id ?? 0) + 1),
    at: new Date().toISOString(),
    project: currentProject(),
    to,
    text,
    ids,
    ...(box ? { box } : {}),
    ...(area ? { area: true as const } : {}),
    ...(shell ? { enter: true as const } : {}),
  }
  notes.push(note)
  if (notes.length > 200) notes.splice(0, notes.length - 200)
  if (NOTES_FILE) {
    try {
      projectFs.writeFileSync(NOTES_FILE, `${notes.map(n => JSON.stringify(n)).join('\n')}\n`)
    } catch (e) {
      logger.warn('Could not write notes file', e)
    }
  }
  let reached = 0
  watchers.forEach((name, w) => {
    if (forWatcher(note, name)) {
      sendNote(w, note)
      reached++
    }
  })
  if (shell) terminals.get(shell)?.write(`data: ${JSON.stringify({ pid: shell })}\n\n`)
  logger.info(`Note ${note.id} to ${to || 'all'}: ${reached} watcher(s)${shell ? `, Enter in shell ${shell}` : ''}`)
  res.json({ success: true, id: note.id, reached, entered: !!shell })
})
app.get('/api/events', (req: Request, res: Response) => {
  const name = WATCHER_NAME.test(String(req.query.name ?? '')) ? String(req.query.name) : 'session'
  const since = Number(req.header('last-event-id') ?? req.query.since ?? NaN)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': hello\n\n')
  if (Number.isFinite(since)) for (const n of notes) if (n.id > since && forWatcher(n, name)) sendNote(res, n)
  watchers.set(res, name)
  const beat = setInterval(() => res.write(': beat\n\n'), 25000)
  req.on('close', () => {
    clearInterval(beat)
    watchers.delete(res)
  })
})
// Names of the open watchers, for the canvas "To" picker.
app.get('/api/watchers', (_req: Request, res: Response) => {
  res.json({ success: true, watchers: [...new Set(watchers.values())].sort() })
})
// Live Claude Code sessions on this Mac, for the canvas "To" picker. Claude Code writes one file per running
// session (name, folder, idle/busy); a session listens as `cc-<first 8 of its id>` (the SessionStart hook in
// install.sh starts `draw watch --once` under that name). Watchers that are no session are listed too.
// terminal: the session runs in a VS Code terminal the extension reported, so a note can press Enter there.
const SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR ?? path.join(process.env.HOME ?? '', '.claude', 'sessions')
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
// The devboard VS Code extension (../vscode) holds this open per window with the shell pids of its terminals.
const terminals = new Map<number, Response>()
app.get('/api/terminals', (req: Request, res: Response) => {
  const pids = String(req.query.pids ?? '')
    .split(',')
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 1)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(': hello\n\n')
  for (const p of pids) terminals.set(p, res)
  const beat = setInterval(() => res.write(': beat\n\n'), 25000)
  req.on('close', () => {
    clearInterval(beat)
    pids.forEach(p => {
      if (terminals.get(p) === res) terminals.delete(p)
    })
  })
})
// The VS Code terminal shell a process runs under: the nearest parent the extension listed.
const parentPids = (): Map<number, number> => {
  if (!terminals.size) return new Map()
  try {
    return new Map(
      execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map(l => l.trim().split(/\s+/).map(Number) as [number, number]),
    )
  } catch {
    return new Map()
  }
}
const shellOf = (pid: number, parents: Map<number, number>): number | undefined => {
  for (let p = parents.get(pid), i = 0; p && p > 1 && i < 6; p = parents.get(p), i++) if (terminals.has(p)) return p
  return undefined
}
const liveSessions = () => {
  const parents = parentPids()
  const listening = new Set(watchers.values())
  let files: string[] = []
  try {
    files = projectFs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    /* no Claude Code here */
  }
  return files
    .flatMap(f => {
      try {
        const d = JSON.parse(projectFs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))
        if (!Number.isInteger(d.pid) || !alive(d.pid) || typeof d.sessionId !== 'string') return []
        const watch = `cc-${d.sessionId.replace(/[^a-f0-9]/g, '').slice(0, 8)}`
        return [
          {
            watch,
            name: String(d.name || watch),
            folder: path.basename(String(d.cwd ?? '')),
            status: d.status === 'busy' ? 'busy' : 'idle',
            listening: listening.has(watch),
            updated: Number(d.updatedAt) || 0,
            shell: shellOf(d.pid, parents),
          },
        ]
      } catch {
        return []
      }
    })
    .sort((a, b) => Number(b.listening) - Number(a.listening) || b.updated - a.updated)
}
app.get('/api/sessions', (_req: Request, res: Response) => {
  const sessions = liveSessions().map(({ shell, ...x }) => ({ ...x, terminal: !!shell }))
  const known = new Set(sessions.map(x => x.watch))
  res.json({ success: true, sessions, others: [...new Set(watchers.values())].filter(n => !known.has(n)).sort() })
})

// Local patch: projects (boards) in folders. agent.mjs sets EXCALIDRAW_PROJECTS_DIR and EXCALIDRAW_CURRENT_FILE
// (the open board's path). A board is a folder that holds canvas-state-v1.json; any other folder is a folder.
// Paths use "/" (clients/acme/flow), at most 5 deep. Opening a board swaps the data directory in this process
// and sends open tabs the new scene.
const PROJECTS_DIR = process.env.EXCALIDRAW_PROJECTS_DIR
const CURRENT_FILE = process.env.EXCALIDRAW_CURRENT_FILE
// Every project route checks projectsOff first; these hold the same fact for the helpers below.
const projectsRoot = (): string => {
  if (!PROJECTS_DIR) throw new Error('projects off')
  return PROJECTS_DIR
}
const currentFile = (): string => {
  if (!CURRENT_FILE) throw new Error('projects off')
  return CURRENT_FILE
}
const WATCHER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/ // `draw watch --name`, the canvas "To" picker
const BOARD_PATH = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}(\/[A-Za-z0-9][A-Za-z0-9 _-]{0,47}){0,4}$/
const STATE_FILE = 'canvas-state-v1.json',
  THUMB_FILE = 'thumb.png'
const boardPath = (v: unknown): string | null => {
  const p = String(v ?? '')
    .split('/')
    .map(s => s.trim())
    .join('/')
  return BOARD_PATH.test(p) ? p : null
}
const projectDir = (p: string) => path.join(projectsRoot(), ...p.split('/'))
const currentProject = (): string => {
  if (!CURRENT_FILE) return 'main'
  try {
    return boardPath(projectFs.readFileSync(CURRENT_FILE, 'utf8').trim()) ?? 'main'
  } catch {
    return 'main'
  }
}
const isBoard = (p: string) => p === currentProject() || projectFs.existsSync(path.join(projectDir(p), STATE_FILE))
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
// Every board and folder under PROJECTS_DIR. Boards hold no folders.
function walkProjects() {
  const boards: { path: string; updated: number; thumb: boolean }[] = [],
    folders: string[] = []
  const walk = (rel: string, depth: number) => {
    for (const d of projectFs.readdirSync(rel ? projectDir(rel) : projectsRoot(), { withFileTypes: true })) {
      const p = rel ? `${rel}/${d.name}` : d.name
      if (!d.isDirectory() || !boardPath(p) || boardPath(p) !== p) continue
      if (isBoard(p)) {
        const st = (f: string) => {
          try {
            return projectFs.statSync(path.join(projectDir(p), f)).mtimeMs
          } catch {
            return 0
          }
        }
        boards.push({ path: p, updated: Math.round(st(STATE_FILE)), thumb: st(THUMB_FILE) > 0 })
      } else {
        folders.push(p)
        if (depth < 4) walk(p, depth + 1)
      }
    }
  }
  walk('', 0)
  return { boards: boards.sort((a, b) => a.path.localeCompare(b.path)), folders: folders.sort() }
}
const projectsOff = (res: Response): boolean => {
  if (PROJECTS_DIR && CURRENT_FILE) return false
  res.status(404).json({ success: false, error: 'projects off' })
  return true
}
const sendScene = () => {
  const filesObj: Record<string, ExcalidrawFile> = {}
  files.forEach((f, id) => {
    filesObj[id] = f
  })
  broadcast({
    type: 'initial_elements',
    elements: Array.from(elements.values()),
    project: currentProject(),
    ...(files.size > 0 ? { files: filesObj } : {}),
  } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> })
}
const openBoard = (name: string) => {
  projectFs.mkdirSync(projectDir(name), { recursive: true })
  switchDurableDirectory(projectDir(name))
  projectFs.writeFileSync(currentFile(), `${name}\n`)
  logger.info(`Opened project "${name}" (${elements.size} elements)`)
  broadcast({ type: 'project_opened', project: name })
  sendScene()
}
// A board or folder may not sit inside a board.
const parentIsBoard = (p: string) =>
  p
    .split('/')
    .slice(0, -1)
    .some((_, i, a) => isBoard(a.slice(0, i + 1).join('/')))

app.get('/api/projects', (_req: Request, res: Response) => {
  if (projectsOff(res)) return
  const { boards, folders } = walkProjects()
  res.json({ success: true, current: currentProject(), projects: boards.map(b => b.path), boards, folders })
})
app.post('/api/projects/open', (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const name = boardPath(req.body?.name)
  if (!name)
    return res.status(400).json({ success: false, error: 'name: letters, digits, spaces, dashes; folders with /' })
  if (name === currentProject()) return res.json({ success: true, current: name })
  if (parentIsBoard(name)) return res.status(400).json({ success: false, error: 'a board cannot hold another board' })
  if (projectFs.existsSync(projectDir(name)) && !isBoard(name))
    return res.status(409).json({ success: false, error: `${name} is a folder` })
  try {
    openBoard(name)
  } catch (error) {
    logger.error(`Could not open project "${name}"`, error)
    return res.status(500).json({ success: false, error: (error as Error).message })
  }
  res.json({ success: true, current: name })
})
app.post('/api/projects/folder', (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const name = boardPath(req.body?.path)
  if (!name) return res.status(400).json({ success: false, error: 'name: letters, digits, spaces, dashes' })
  if (projectFs.existsSync(projectDir(name)))
    return res.status(409).json({ success: false, error: `${name} already exists` })
  if (parentIsBoard(name)) return res.status(400).json({ success: false, error: 'a board cannot hold a folder' })
  projectFs.mkdirSync(projectDir(name), { recursive: true })
  broadcast({ type: 'projects_changed' })
  res.json({ success: true, path: name })
})

// Move or rename a board or a folder. The open board may be the one moved or inside it.
const moveProject = (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const from = boardPath(req.body?.from),
    to = boardPath(req.body?.to)
  if (!from || !to) return res.status(400).json({ success: false, error: 'name: letters, digits, spaces, dashes' })
  if (from === to) return res.json({ success: true, current: currentProject() })
  if (!projectFs.existsSync(projectDir(from)))
    return res.status(404).json({ success: false, error: `no project ${from}` })
  if (within(to, from)) return res.status(400).json({ success: false, error: 'cannot move a folder into itself' })
  // A case-only rename finds itself on macOS.
  if (projectFs.existsSync(projectDir(to)) && from.toLowerCase() !== to.toLowerCase())
    return res.status(409).json({ success: false, error: `${to} already exists` })
  if (parentIsBoard(to)) return res.status(400).json({ success: false, error: 'a board cannot hold another board' })
  const cur = currentProject()
  try {
    projectFs.mkdirSync(path.dirname(projectDir(to)), { recursive: true })
    if (within(cur, from)) {
      const next = to + cur.slice(from.length)
      moveDurableDirectory(projectDir(from), projectDir(to), projectDir(next))
      projectFs.writeFileSync(currentFile(), `${next}\n`)
    } else {
      projectFs.renameSync(projectDir(from), projectDir(to))
    }
  } catch (error) {
    logger.error(`Could not move project "${from}"`, error)
    return res.status(500).json({ success: false, error: (error as Error).message })
  }
  logger.info(`Moved project "${from}" to "${to}"`)
  if (currentProject() !== cur) broadcast({ type: 'project_renamed', from: cur, to: currentProject() })
  broadcast({ type: 'projects_changed' })
  res.json({ success: true, current: currentProject() })
}
app.post('/api/projects/move', moveProject)
app.post('/api/projects/rename', moveProject)

// Delete = move to ../trash/<path with -- for />-<time>. Deleting the open board (or its folder) opens another first.
app.post('/api/projects/delete', (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const name = boardPath(req.body?.name)
  if (!name || !projectFs.existsSync(projectDir(name)))
    return res.status(404).json({ success: false, error: `no project ${name}` })
  try {
    if (within(currentProject(), name)) {
      const next =
        walkProjects()
          .boards.map(b => b.path)
          .find(p => !within(p, name)) ?? (within('main', name) ? 'inbox' : 'main')
      openBoard(next)
    }
    const trash = path.join(projectsRoot(), '..', 'trash')
    projectFs.mkdirSync(trash, { recursive: true })
    projectFs.renameSync(
      projectDir(name),
      path.join(trash, `${name.replace(/\//g, '--')}-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    )
  } catch (error) {
    logger.error(`Could not delete project "${name}"`, error)
    return res.status(500).json({ success: false, error: (error as Error).message })
  }
  logger.info(`Deleted project "${name}" (moved to trash)`)
  broadcast({ type: 'projects_changed' })
  res.json({ success: true, current: currentProject() })
})

// Thumbnails for the Projects view. Only the canvas tab writes one (for the open board, scratch areas left out).
app.post('/api/projects/thumb', express.raw({ type: 'image/png', limit: '2mb' }), (req: Request, res: Response) => {
  if (projectsOff(res)) return
  if (!isTab(req)) return res.status(403).json({ success: false, error: 'canvas tab only' })
  const name = boardPath(req.header('x-canvas-project'))
  if (!name || name !== currentProject() || !Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(409).json({ success: false, error: 'not the open board' })
  projectFs.writeFileSync(path.join(projectDir(name), THUMB_FILE), req.body)
  res.json({ success: true })
})
app.get('/api/projects/thumb', (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const name = boardPath(req.query.path)
  const file = name && path.join(projectDir(name), THUMB_FILE)
  if (!file || !projectFs.existsSync(file)) return res.status(404).end()
  res.set('Cache-Control', 'no-cache').sendFile(path.resolve(file))
})

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
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  })
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
