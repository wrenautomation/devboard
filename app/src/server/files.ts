import type { Express, Request, Response } from 'express'
import { CanvasFileImmutabilityError, commitCanvasMutation, durableStatePath } from '../core/canvas-persistence.js'
import { type ExcalidrawFile, files } from '../types.js'
import logger from '../utils/logger.js'
import { fail, mutationErrorStatus } from './reply.js'
import { broadcast } from './ws.js'

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

export function mountFiles(app: Express): void {
  // ─── Files API (for image elements) ───────────────────────────
  // GET all files
  app.get('/api/files', (_req: Request, res: Response) => {
    res.json({ files: Object.fromEntries(files) })
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
      fail(res, mutationErrorStatus(error, 400), (error as Error).message)
    }
  })

  // DELETE a file
  app.delete('/api/files/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string
      if (!files.has(id)) {
        return fail(res, 404, `File with ID ${id} not found`)
      }
      commitCanvasMutation(() => files.delete(id))
      broadcast({ type: 'file_deleted', fileId: id })
      res.json({ success: true })
    } catch (error) {
      logger.error('Error deleting canvas file:', error)
      fail(res, mutationErrorStatus(error, 500), (error as Error).message)
    }
  })
}
