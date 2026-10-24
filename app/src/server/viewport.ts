import type { Express, Request, Response } from 'express'
import { z } from 'zod'
import logger from '../logger.js'
import { generateId } from '../types.js'
import { fail } from './reply.js'
import { broadcast, clients } from './ws.js'

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

export function mountViewport(app: Express): void {
  app.post('/api/viewport', (req: Request, res: Response) => {
    try {
      const { scrollToContent, scrollToElementIds, scrollToElementId, viewportZoomFactor, zoom, offsetX, offsetY } =
        viewportRequestSchema.parse(req.body)

      if (clients.size === 0) {
        return fail(res, 503, 'No frontend client connected. Open the canvas in a browser first.')
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
          fail(res, 500, (error as Error).message)
        })
    } catch (error) {
      logger.error('Error initiating viewport change:', error)
      fail(
        res,
        error instanceof z.ZodError ? 400 : 500,
        error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : (error as Error).message,
      )
    }
  })

  // Viewport control: result (Frontend -> Express -> MCP)
  app.post('/api/viewport/result', (req: Request, res: Response) => {
    try {
      const { requestId, success, message, error } = req.body

      if (!requestId) {
        return fail(res, 400, 'requestId is required')
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
      fail(res, 500, (error as Error).message)
    }
  })
}
