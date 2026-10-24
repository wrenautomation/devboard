import type { Express, Request, Response } from 'express'
import { z } from 'zod'
import { MAX_SCALE, RenderError, renderScene } from '../core/render/index.js'
import logger from '../logger.js'
import { elements, files, generateId } from '../types.js'
import { fail } from './reply.js'
import { scratchHidden, visibleTo } from './scratch.js'
import { broadcast, clients, sceneMessage } from './ws.js'

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
  broadcast(sceneMessage())

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

export function mountExport(app: Express): void {
  app.post('/api/export/image', async (req: Request, res: Response) => {
    const parsed = exportImageSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.join('.')
      return fail(
        res,
        400,
        where === 'format'
          ? 'format must be "png" or "svg"'
          : `${where ? `${where}: ` : ''}${issue?.message ?? 'invalid request'}`,
      )
    }
    const options = parsed.data
    if (options.embedScene && options.format !== 'png') {
      return fail(res, 400, 'embedScene is only supported for PNG exports')
    }
    const renderer = options.renderer ?? 'auto'

    const respondBrowser = async () => {
      if (clients.size === 0) {
        return fail(res, 503, NO_BROWSER_TAB_ERROR)
      }
      try {
        const result = await exportViaBrowserTab({ ...options, hide: [...scratchHidden()] } as ExportImageBody)
        res.json({ success: true, format: result.format, data: result.data, renderer: 'browser' })
      } catch (error) {
        fail(res, 500, (error as Error).message)
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
        return fail(res, error.status, error.message)
      }
      logger.error('Headless image export failed:', error)
      if (renderer === 'auto' && clients.size > 0) {
        // The reference renderer is available; use it rather than fail
        logger.warn('Falling back to the browser tab for this export')
        return respondBrowser()
      }
      fail(res, 500, (error as Error).message)
    }
  })

  // Image export: result (Frontend -> Express -> MCP)
  app.post('/api/export/image/result', (req: Request, res: Response) => {
    try {
      const { requestId, format, data, error } = req.body

      if (!requestId) {
        return fail(res, 400, 'requestId is required')
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
      fail(res, 500, (error as Error).message)
    }
  })
}
