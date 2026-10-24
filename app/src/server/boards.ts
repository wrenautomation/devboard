import * as projectFs from 'node:fs'
import path from 'node:path'

// Local patch: projects (boards) in folders. agent.mjs sets EXCALIDRAW_PROJECTS_DIR and EXCALIDRAW_CURRENT_FILE
// (the open board's path). A board is a folder that holds canvas-state-v1.json; any other folder is a folder.
// Paths use "/" (clients/acme/flow), at most 5 deep. Opening a board swaps the data directory in this process
// and sends open tabs the new scene.
export const PROJECTS_DIR = process.env.EXCALIDRAW_PROJECTS_DIR
export const CURRENT_FILE = process.env.EXCALIDRAW_CURRENT_FILE
// Every project route checks projectsOff first; these hold the same fact for the helpers below.
export const projectsRoot = (): string => {
  if (!PROJECTS_DIR) throw new Error('projects off')
  return PROJECTS_DIR
}
export const currentFile = (): string => {
  if (!CURRENT_FILE) throw new Error('projects off')
  return CURRENT_FILE
}
export const BOARD_PATH = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}(\/[A-Za-z0-9][A-Za-z0-9 _-]{0,47}){0,4}$/
export const STATE_FILE = 'canvas-state-v1.json',
  THUMB_FILE = 'thumb.png'
export const boardPath = (v: unknown): string | null => {
  const p = String(v ?? '')
    .split('/')
    .map(s => s.trim())
    .join('/')
  return BOARD_PATH.test(p) ? p : null
}
export const projectDir = (p: string) => path.join(projectsRoot(), ...p.split('/'))
export const currentProject = (): string => {
  if (!CURRENT_FILE) return 'main'
  try {
    return boardPath(projectFs.readFileSync(CURRENT_FILE, 'utf8').trim()) ?? 'main'
  } catch {
    return 'main'
  }
}
export const isBoard = (p: string) =>
  p === currentProject() || projectFs.existsSync(path.join(projectDir(p), STATE_FILE))
export const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
// Every board and folder under PROJECTS_DIR. Boards hold no folders.
export function walkProjects() {
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
// A board or folder may not sit inside a board.
export const parentIsBoard = (p: string) =>
  p
    .split('/')
    .slice(0, -1)
    .some((_, i, a) => isBoard(a.slice(0, i + 1).join('/')))
