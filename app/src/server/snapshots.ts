import type { Express, Request, Response } from 'express'
import { commitCanvasMutation } from '../core/canvas-persistence.js'
import logger from '../logger.js'
import { elements, type Snapshot, snapshots } from '../types.js'
import { fail, mutationErrorStatus } from './reply.js'
import { visibleTo } from './scratch.js'

export function mountSnapshots(app: Express): void {
  // Snapshots: save
  app.post('/api/snapshots', (req: Request, res: Response) => {
    try {
      const { name } = req.body

      if (!name || typeof name !== 'string') {
        return fail(res, 400, 'Snapshot name is required')
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
      fail(res, mutationErrorStatus(error, 500), (error as Error).message)
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
      fail(res, 500, (error as Error).message)
    }
  })

  // Snapshots: get by name
  app.get('/api/snapshots/:name', (req: Request, res: Response) => {
    try {
      const { name = '' } = req.params
      const snapshot = snapshots.get(name)

      if (!snapshot) {
        return fail(res, 404, `Snapshot "${name}" not found`)
      }

      res.json({
        success: true,
        snapshot: { ...snapshot, elements: visibleTo(req, snapshot.elements) },
      })
    } catch (error) {
      logger.error('Error fetching snapshot:', error)
      fail(res, 500, (error as Error).message)
    }
  })
}
