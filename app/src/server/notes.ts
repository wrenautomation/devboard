import { execFileSync } from 'node:child_process'
import * as projectFs from 'node:fs'
import path from 'node:path'
import type { Express, Request, Response } from 'express'
import logger from '../logger.js'
import { currentProject } from './boards.js'
import { fail } from './reply.js'
import { scratchHidden } from './scratch.js'

export const WATCHER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/ // `draw watch --name`, the canvas "To" picker

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
  // A note from a page on this Mac (Storybook's Agentation Send): the page it is about.
  link?: string
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

// Live Claude Code sessions on this Mac, for the canvas "To" picker. Claude Code writes one file per running
// session (name, folder, idle/busy); a session listens as `cc-<first 8 of its id>` (the SessionStart hook in
// install.sh starts `draw watch --once` under that name). Watchers that are no session are listed too.
// terminal: the session runs in a VS Code terminal the extension reported, so a note can press Enter there.
const SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR ?? path.join(process.env.HOME ?? '', '.claude', 'sessions')

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

export function mountNotes(app: Express): void {
  app.post('/api/notify', (req: Request, res: Response) => {
    const text = String(req.body?.text ?? '')
      .trim()
      .slice(0, 12000) // an Agentation Send carries selectors for each mark
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
    if (!text && !ids.length && !area) return fail(res, 400, 'note needs text, selected shapes or a marked area')
    const link = String(req.body?.link ?? '')
    const local = link.length <= 500 && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(link)
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
      ...(local ? { link } : {}),
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
  app.get('/api/sessions', (_req: Request, res: Response) => {
    const sessions = liveSessions().map(({ shell, ...x }) => ({ ...x, terminal: !!shell }))
    const known = new Set(sessions.map(x => x.watch))
    res.json({ success: true, sessions, others: [...new Set(watchers.values())].filter(n => !known.has(n)).sort() })
  })
}
