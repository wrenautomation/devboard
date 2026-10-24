import type { Express, Request, Response } from 'express'
import { z } from 'zod'
import { commitCanvasMutation } from '../core/canvas-persistence.js'
import { normalizePoints } from '../core/normalize.js'
import {
  type BatchCreatedMessage,
  type ElementCreatedMessage,
  type ElementDeletedMessage,
  type ElementUpdatedMessage,
  EXCALIDRAW_ELEMENT_TYPES,
  type ExcalidrawElementType,
  elements,
  generateId,
  normalizeFontFamily,
  type ServerElement,
} from '../types.js'
import logger from '../utils/logger.js'
import { CURRENT_FILE, currentProject, PROJECTS_DIR } from './boards.js'
import { fail, mutationErrorStatus } from './reply.js'
import { scratchBlock, scratchKept, visibleTo } from './scratch.js'
import { broadcast } from './ws.js'

// Every server-side write is an edit: a new versionNonce with each version, so Excalidraw's tie-break
// (same version, lower nonce wins) stays fair between the server and the tabs.
export const freshNonce = () => Math.floor(Math.random() * 2 ** 31)

function normalizeLineBreakMarkup(text: string): string {
  return text.replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n').replace(/\n{3,}/g, '\n\n')
}

// Schema validation. The fields an element may carry are one list; create requires type, x and y,
// update requires an id and takes the rest as optional. Both pass unknown Excalidraw fields through.
const elementFields = {
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
  // Arrow-specific properties (points: see the two schemas)
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
}

const elementType = z.enum(
  Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]],
)

const point = z.union([z.tuple([z.number(), z.number()]), z.object({ x: z.number(), y: z.number() })])

const CreateElementSchema = z
  .object({
    id: z.string().optional(), // Allow passing ID for MCP sync
    type: elementType,
    x: z.number(),
    y: z.number(),
    points: z.any().optional(),
    ...elementFields,
  })
  .passthrough()

const UpdateElementSchema = z
  .object({
    id: z.string(),
    type: elementType.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    originalText: z.string().optional(),
    points: z.array(point).optional(),
    ...elementFields,
  })
  .passthrough()

// API Routes

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

// Merge push from a tab: only the shapes it changed, deletes included (isDeleted). Excalidraw's rule
// picks the winner per shape: the higher version, then the lower versionNonce. The same push sent twice
// is a no-op, so a tab can retry after a lost reply. The losers come back so the tab can take them.
type PushedElement = ServerElement & { version: number }

const isPushedElement = (e: unknown): e is PushedElement =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as PushedElement).id === 'string' &&
  Number.isFinite((e as PushedElement).version)

export function mountElements(app: Express): void {
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
      fail(res, 500, (error as Error).message)
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
      fail(res, mutationErrorStatus(error, 400), (error as Error).message)
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
        return fail(res, 400, 'Element ID is required')
      }

      const existingElement = elements.get(id)
      if (!existingElement) {
        return fail(res, 404, `Element with ID ${id} not found`)
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
        const existingOriginalText =
          typeof existingElement.originalText === 'string' ? existingElement.originalText : ''
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
      fail(res, mutationErrorStatus(error, 400), (error as Error).message)
    }
  })

  // Clear all elements (must be before /:id route)
  app.delete('/api/elements/clear', (req: Request, res: Response) => {
    try {
      const kept = scratchKept(req)
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
      fail(res, mutationErrorStatus(error, 500), (error as Error).message)
    }
  })

  // Delete element
  app.delete('/api/elements/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params

      if (!id) {
        return fail(res, 400, 'Element ID is required')
      }

      if (!elements.has(id)) {
        return fail(res, 404, `Element with ID ${id} not found`)
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
      fail(res, mutationErrorStatus(error, 500), (error as Error).message)
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
      fail(res, 500, (error as Error).message)
    }
  })

  // Get element by ID
  app.get('/api/elements/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params

      if (!id) {
        return fail(res, 400, 'Element ID is required')
      }

      const element = elements.get(id)

      if (!element) {
        return fail(res, 404, `Element with ID ${id} not found`)
      }
      if (scratchBlock(req, res, id, false)) return

      res.json({
        success: true,
        element: element,
      })
    } catch (error) {
      logger.error('Error fetching element:', error)
      fail(res, 500, (error as Error).message)
    }
  })

  // Batch create elements
  app.post('/api/elements/batch', (req: Request, res: Response) => {
    try {
      const { elements: elementsToCreate, replace = false } = req.body ?? {}

      if (!Array.isArray(elementsToCreate)) {
        return fail(res, 400, 'Expected an array of elements')
      }
      if (typeof replace !== 'boolean') {
        return fail(res, 400, 'replace must be a boolean')
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

      const kept = replace ? scratchKept(req) : []
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
      fail(res, mutationErrorStatus(error, 400), (error as Error).message)
    }
  })

  // Convert Mermaid diagram to Excalidraw elements
  app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
    try {
      const { mermaidDiagram, config } = req.body

      if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
        return fail(res, 400, 'Mermaid diagram definition is required')
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
      fail(res, 400, (error as Error).message)
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
        return fail(res, 400, 'Expected elements to be an array')
      }

      logger.info(`Sync request received: ${frontendElements.length} elements`, {
        timestamp,
        elementCount: frontendElements.length,
      })

      // Record element count before sync
      const beforeCount = elements.size
      let successCount = 0
      const processedElements: ServerElement[] = []

      const kept = scratchKept(req)
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

  app.post('/api/elements/push', (req: Request, res: Response) => {
    try {
      const forProject = req.header('x-canvas-project')
      if (PROJECTS_DIR && CURRENT_FILE && forProject && forProject !== currentProject()) {
        return res.status(409).json({ success: false, error: 'project_changed', current: currentProject() })
      }
      const incoming: unknown = req.body?.elements
      if (!Array.isArray(incoming) || !incoming.every(isPushedElement)) {
        return fail(res, 400, 'Expected elements with id and version')
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
      fail(res, mutationErrorStatus(error, 500), (error as Error).message)
    }
  })
}
