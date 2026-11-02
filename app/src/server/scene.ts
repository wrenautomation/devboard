import * as fs from 'node:fs'
import path from 'node:path'
import type { Express, Request, Response } from 'express'
import { compact } from '../core/compact.js'
import { type ExcalidrawFile, elements, files, type ServerElement } from '../types.js'
import { boardPath, currentProject, isBoard, projectDir, STATE_FILE } from './boards.js'
import { fail } from './reply.js'
import { isTab } from './scratch.js'

// Local patch: any board's scene by delta, open or closed, for instant switch and preload.
// Design: designs/2026-11-02-board-pins.md (Switch).

interface FileRecord {
  id: string
  blob: string
  mimeType: string
}
interface ClosedBoard {
  mtime: number
  elements: ServerElement[]
  files: Map<string, FileRecord>
}
// parsed state files of closed boards, by path; dropped when the file changes
const closed = new Map<string, ClosedBoard>()

function readClosed(name: string): ClosedBoard | null {
  const file = path.join(projectDir(name), STATE_FILE)
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const hit = closed.get(name)
  if (hit?.mtime === mtime) return hit
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { elements: ServerElement[]; files: FileRecord[] }
  const board = { mtime, elements: raw.elements.map(compact), files: new Map(raw.files.map(f => [f.id, f])) }
  closed.set(name, board)
  return board
}

const stampOf = (el: { version?: number; versionNonce?: number }) => `${el.version}:${el.versionNonce ?? 0}`

// one image of a board: the open board from memory, a closed one from its blob
export function boardFile(name: string | null, id: string): Pick<ExcalidrawFile, 'dataURL' | 'mimeType'> | null {
  if (!name || name === currentProject()) return files.get(id) ?? null
  const record = readClosed(name)?.files.get(id)
  if (!record) return null
  try {
    return { dataURL: fs.readFileSync(path.join(projectDir(name), record.blob), 'utf8'), mimeType: record.mimeType }
  } catch {
    return null
  }
}

export function mountScene(app: Express): void {
  // body {name, have: {id: "version:nonce"}}: every id, and only the elements the tab lacks or holds older
  // tab only: it holds scratch areas, which agents never read
  app.post('/api/projects/scene', (req: Request, res: Response) => {
    if (!isTab(req)) return fail(res, 403, 'canvas tab only')
    const name = boardPath(req.body?.name)
    if (!name) return fail(res, 400, 'bad board name')
    const have = (req.body?.have ?? {}) as Record<string, string>
    const open = currentProject()
    let els: ServerElement[], fileIds: string[]
    if (name === open) {
      els = [...elements.values()].map(compact)
      fileIds = [...files.keys()]
    } else {
      if (!isBoard(name)) return fail(res, 404, 'no such board')
      const board = readClosed(name)
      els = board?.elements ?? []
      fileIds = board ? [...board.files.keys()] : []
    }
    res.json({
      success: true,
      project: name,
      open,
      ids: els.map(e => e.id),
      changed: els.filter(e => have[e.id] !== stampOf(e)),
      fileIds,
    })
  })
}
