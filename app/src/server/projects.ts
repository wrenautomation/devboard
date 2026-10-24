import * as projectFs from 'node:fs'
import path from 'node:path'
import express, { type Express, type Request, type Response } from 'express'
import { moveDurableDirectory, switchDurableDirectory } from '../core/canvas-persistence.js'
import { elements } from '../types.js'
import logger from '../utils/logger.js'
import {
  boardPath,
  CURRENT_FILE,
  currentFile,
  currentProject,
  isBoard,
  PROJECTS_DIR,
  parentIsBoard,
  projectDir,
  projectsRoot,
  THUMB_FILE,
  walkProjects,
  within,
} from './boards.js'
import { fail } from './reply.js'
import { isTab } from './scratch.js'
import { broadcast, sceneMessage } from './ws.js'

const projectsOff = (res: Response): boolean => {
  if (PROJECTS_DIR && CURRENT_FILE) return false
  fail(res, 404, 'projects off')
  return true
}

const openBoard = (name: string) => {
  projectFs.mkdirSync(projectDir(name), { recursive: true })
  switchDurableDirectory(projectDir(name))
  projectFs.writeFileSync(currentFile(), `${name}\n`)
  logger.info(`Opened project "${name}" (${elements.size} elements)`)
  broadcast({ type: 'project_opened', project: name })
  broadcast(sceneMessage())
}

// Move or rename a board or a folder. The open board may be the one moved or inside it.
const moveProject = (req: Request, res: Response) => {
  if (projectsOff(res)) return
  const from = boardPath(req.body?.from),
    to = boardPath(req.body?.to)
  if (!from || !to) return fail(res, 400, 'name: letters, digits, spaces, dashes')
  if (from === to) return res.json({ success: true, current: currentProject() })
  if (!projectFs.existsSync(projectDir(from))) return fail(res, 404, `no project ${from}`)
  if (within(to, from)) return fail(res, 400, 'cannot move a folder into itself')
  // A case-only rename finds itself on macOS.
  if (projectFs.existsSync(projectDir(to)) && from.toLowerCase() !== to.toLowerCase())
    return fail(res, 409, `${to} already exists`)
  if (parentIsBoard(to)) return fail(res, 400, 'a board cannot hold another board')
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
    return fail(res, 500, (error as Error).message)
  }
  logger.info(`Moved project "${from}" to "${to}"`)
  if (currentProject() !== cur) broadcast({ type: 'project_renamed', from: cur, to: currentProject() })
  broadcast({ type: 'projects_changed' })
  res.json({ success: true, current: currentProject() })
}

export function mountProjects(app: Express): void {
  app.get('/api/projects', (_req: Request, res: Response) => {
    if (projectsOff(res)) return
    const { boards, folders } = walkProjects()
    res.json({ success: true, current: currentProject(), projects: boards.map(b => b.path), boards, folders })
  })

  app.post('/api/projects/open', (req: Request, res: Response) => {
    if (projectsOff(res)) return
    const name = boardPath(req.body?.name)
    if (!name) return fail(res, 400, 'name: letters, digits, spaces, dashes; folders with /')
    if (name === currentProject()) return res.json({ success: true, current: name })
    if (parentIsBoard(name)) return fail(res, 400, 'a board cannot hold another board')
    if (projectFs.existsSync(projectDir(name)) && !isBoard(name)) return fail(res, 409, `${name} is a folder`)
    try {
      openBoard(name)
    } catch (error) {
      logger.error(`Could not open project "${name}"`, error)
      return fail(res, 500, (error as Error).message)
    }
    res.json({ success: true, current: name })
  })

  app.post('/api/projects/folder', (req: Request, res: Response) => {
    if (projectsOff(res)) return
    const name = boardPath(req.body?.path)
    if (!name) return fail(res, 400, 'name: letters, digits, spaces, dashes')
    if (projectFs.existsSync(projectDir(name))) return fail(res, 409, `${name} already exists`)
    if (parentIsBoard(name)) return fail(res, 400, 'a board cannot hold a folder')
    projectFs.mkdirSync(projectDir(name), { recursive: true })
    broadcast({ type: 'projects_changed' })
    res.json({ success: true, path: name })
  })

  app.post('/api/projects/move', moveProject)

  app.post('/api/projects/rename', moveProject)

  // Delete = move to ../trash/<path with -- for />-<time>. Deleting the open board (or its folder) opens another first.
  app.post('/api/projects/delete', (req: Request, res: Response) => {
    if (projectsOff(res)) return
    const name = boardPath(req.body?.name)
    if (!name || !projectFs.existsSync(projectDir(name))) return fail(res, 404, `no project ${name}`)
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
      return fail(res, 500, (error as Error).message)
    }
    logger.info(`Deleted project "${name}" (moved to trash)`)
    broadcast({ type: 'projects_changed' })
    res.json({ success: true, current: currentProject() })
  })

  // Thumbnails for the Projects view. Only the canvas tab writes one (for the open board, scratch areas left out).
  app.post('/api/projects/thumb', express.raw({ type: 'image/png', limit: '2mb' }), (req: Request, res: Response) => {
    if (projectsOff(res)) return
    if (!isTab(req)) return fail(res, 403, 'canvas tab only')
    const name = boardPath(req.header('x-canvas-project'))
    if (!name || name !== currentProject() || !Buffer.isBuffer(req.body) || !req.body.length)
      return fail(res, 409, 'not the open board')
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
}
