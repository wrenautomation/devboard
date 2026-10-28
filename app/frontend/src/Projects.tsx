// Local patch: Projects view. Boards live in folders (paths like clients/acme/flow): a file tree on the left,
// the open folder's cards on the right. A folder card shows its four latest boards. A star on each card
// (one tap) pins it to Starred and sorts it first. Hold a card or a tree row and drop it on a folder, a tree
// row or the path to move it. Each item also has Rename, Move and Delete.
// The server does the work (/api/projects*); every tab gets projects_changed and refreshes.

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, postJson } from './api'
import { ChevronDown, ChevronRight, FileIcon, Folder, FolderPlus, MoreHorizontal, Plus, Search, Star, X } from './icons'

type Board = { path: string; updated: number; thumb: boolean }
type State = { current: string; boards: Board[]; folders: string[]; starred?: string[] }
type Ask =
  | { kind: 'board' | 'folder'; value: string }
  | { kind: 'rename'; target: string; value: string }
  | { kind: 'move'; target: string }
  | { kind: 'delete'; target: string }

const parent = (p: string) => p.split('/').slice(0, -1).join('/')
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
// A drop that moves something: not into the folder it sits in, not into itself.
const canMove = (from: string, to: string) => parent(from) !== to && !within(to, from)
const thumbUrl = (b: Board, bust = 0) => `/api/projects/thumb?path=${encodeURIComponent(b.path)}&v=${b.updated}-${bust}`

// A card or tree row: dragged by a hold (touch) or a short drag (mouse); a folder also takes drops.
function useItem(key: string, path: string, folder: string | null) {
  const drag = useDraggable({ id: `${key}:${path}`, data: { path } })
  const drop = useDroppable({ id: `${key}>${path}`, data: { folder }, disabled: folder === null })
  const from = drag.active?.data.current?.path
  return {
    ref: (n: HTMLElement | null) => {
      drag.setNodeRef(n)
      drop.setNodeRef(n)
    },
    handle: drag.listeners, // no role or tabindex: the card's own buttons take focus
    dragging: drag.isDragging,
    over: drop.isOver && folder !== null && typeof from === 'string' && canMove(from, folder),
  }
}

// A drop target with no drag of its own: a step of the path.
function DropCrumb({ folder, className, children }: { folder: string; className?: string; children: React.ReactNode }) {
  const drop = useDroppable({ id: `crumb>${folder}`, data: { folder } })
  const from = drop.active?.data.current?.path
  const over = drop.isOver && typeof from === 'string' && canMove(from, folder)
  return (
    <span ref={drop.setNodeRef} className={[className, over && 'pj-drop'].filter(Boolean).join(' ') || undefined}>
      {children}
    </span>
  )
}
// What the server takes: letters, digits, spaces, dashes, underscores.
const cleanName = (typed: string) =>
  typed
    .trim()
    .replace(/[^A-Za-z0-9 _-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 48)
    .trim()
const ago = (ms: number) => {
  if (!ms) return 'Empty'
  const s = (Date.now() - ms) / 1000,
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (s < 60) return 'Edited just now'
  // unit, its seconds, how many before the next unit
  for (const [unit, n, max] of [
    ['minute', 60, 60],
    ['hour', 3600, 24],
    ['day', 86400, 7],
    ['week', 604800, 5],
  ] as const) {
    if (s < n * max) return `Edited ${rtf.format(-Math.floor(s / n), unit)}`
  }
  return `Edited ${new Date(ms).toLocaleDateString()}`
}

type Ctx = {
  state: State
  starred: Set<string>
  nonce: number
  menu: string | null
  dir: string
  starredView: boolean
  fullNames: boolean
  expanded: Set<string>
  inFolder: (f: string) => number
  more: (p: string) => React.ReactNode
  itemMenu: (p: string) => React.ReactNode
  openBoard: (p: string) => void
  goto: (f: string) => void
  star: (p: string) => void
  tap: (f: () => void) => () => void
  toggle: (f: string) => void
}

const bust = (c: Ctx, b: Board) => (b.path === c.state.current ? c.nonce : 0)

// A folder's art: its four latest boards (any depth), one fills the card.
function FolderArt({ c, f }: { c: Ctx; f: string }) {
  const latest = c.state.boards
    .filter(b => b.thumb && within(b.path, f))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 4)
  if (!latest.length) return <Folder size={44} strokeWidth={1.4} />
  return (
    <div className={`pj-mosaic n${latest.length}`}>
      {latest.map(b => (
        <img key={b.path} src={thumbUrl(b, bust(c, b))} alt="" loading="lazy" draggable={false} />
      ))}
      <span className="pj-badge">
        <Folder size={16} fill="currentColor" />
      </span>
    </div>
  )
}

function Card({ c, path }: { c: Ctx; path: string }) {
  const board = c.state.boards.find(b => b.path === path)
  const it = useItem('card', path, board ? null : path)
  const on = path === c.state.current,
    starred = c.starred.has(path),
    n = board ? 0 : c.inFolder(path)
  return (
    <div
      ref={it.ref}
      {...it.handle}
      className={['pj-card', !board && 'pj-folder', on && 'on', it.over && 'pj-drop', it.dragging && 'pj-moving']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className="pj-hit"
        onClick={c.tap(() => (board ? c.openBoard(path) : c.goto(path)))}
        aria-current={on ? 'true' : undefined}
      >
        <div className="pj-art">
          {!board ? (
            <FolderArt c={c} f={path} />
          ) : board.thumb ? (
            <img src={thumbUrl(board, bust(c, board))} alt="" loading="lazy" draggable={false} />
          ) : (
            <FileIcon size={40} strokeWidth={1.4} />
          )}
        </div>
        <div className="pj-meta">
          <b>
            {!board && <Folder size={15} className="pj-kind" />}
            {c.fullNames ? path : base(path)}
          </b>
          <span>{board ? (on ? 'Open now' : ago(board.updated)) : n === 1 ? '1 board' : `${n} boards`}</span>
        </div>
      </button>
      <button
        type="button"
        className={`pj-star ${starred ? 'on' : ''}`}
        aria-pressed={starred}
        aria-label={`${starred ? 'Unstar' : 'Star'} ${base(path)}`}
        onClick={e => {
          e.stopPropagation()
          c.star(path)
        }}
      >
        <Star size={18} fill={starred ? 'currentColor' : 'none'} />
      </button>
      {c.more(path)}
      {c.menu === path && c.itemMenu(path)}
    </div>
  )
}

function TreeFolder({ c, f, depth }: { c: Ctx; f: string; depth: number }) {
  const it = useItem('tree', f, f)
  const open = c.expanded.has(f)
  return (
    <>
      <div
        ref={it.ref}
        {...it.handle}
        className={['pj-row', it.over && 'pj-drop', it.dragging && 'pj-moving'].filter(Boolean).join(' ')}
        style={{ paddingLeft: (depth - 1) * 14 }}
      >
        <button
          type="button"
          className="pj-twist"
          aria-expanded={open}
          aria-label={`${open ? 'Fold' : 'Unfold'} ${base(f)}`}
          onClick={c.tap(() => c.toggle(f))}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          className="pj-row-hit"
          aria-current={!c.starredView && c.dir === f ? 'page' : undefined}
          onClick={c.tap(() => c.goto(f))}
        >
          <Folder size={16} /> <span>{base(f)}</span>
          {c.starred.has(f) && <Star size={12} fill="currentColor" className="pj-star-icon" />}
        </button>
      </div>
      {open && (
        <>
          {c.state.folders
            .filter(x => parent(x) === f)
            .map(x => (
              <TreeFolder key={x} c={c} f={x} depth={depth + 1} />
            ))}
          {c.state.boards
            .filter(b => parent(b.path) === f)
            .map(b => (
              <TreeBoard key={b.path} c={c} path={b.path} depth={depth + 1} />
            ))}
        </>
      )}
    </>
  )
}

function TreeBoard({ c, path, depth }: { c: Ctx; path: string; depth: number }) {
  const it = useItem('tree', path, null)
  return (
    <div
      ref={it.ref}
      {...it.handle}
      className={['pj-row', it.dragging && 'pj-moving'].filter(Boolean).join(' ')}
      style={{ paddingLeft: (depth - 1) * 14 }}
    >
      <span className="pj-twist" />
      <button
        type="button"
        className="pj-row-hit"
        aria-current={path === c.state.current ? 'true' : undefined}
        onClick={c.tap(() => c.openBoard(path))}
      >
        <FileIcon size={16} /> <span>{base(path)}</span>
        {c.starred.has(path) && <Star size={12} fill="currentColor" className="pj-star-icon" />}
      </button>
    </div>
  )
}

export function Projects({
  beforeSwitch,
  saveThumb,
}: {
  beforeSwitch: () => Promise<void>
  saveThumb: () => Promise<void>
}) {
  const [state, setState] = useState<State | null>(null)
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState('')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0) // busts the open board's thumbnail after it is saved again
  const [starredView, setStarredView] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState<string | null>(null) // the path under the finger while it drags
  const dropped = useRef(0) // when the last drag ended: the click that follows it is not a tap
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )

  const refresh = useCallback(() => getJson<State>('/api/projects').then(d => d && setState(d)), [])
  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener('canvas-project', onChange)
    window.addEventListener('canvas-projects-changed', onChange)
    return () => {
      window.removeEventListener('canvas-project', onChange)
      window.removeEventListener('canvas-projects-changed', onChange)
    }
  }, [refresh])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ask) setAsk(null)
        else if (menu) setMenu(null)
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, ask, menu])

  const show = () => {
    if (!state) return
    const here = parent(state.current)
    setDir(here)
    setStarredView(false)
    setExpanded(new Set(here.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))
    setQuery('')
    setMenu(null)
    setAsk(null)
    setError('')
    setOpen(true)
    void saveThumb().then(() => {
      setNonce(n => n + 1)
      return refresh()
    })
  }
  const run = async (work: () => Promise<unknown>, close = false) => {
    setBusy(true)
    setError('')
    try {
      await work()
      setAsk(null)
      if (close) setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }
  const openBoard = (p: string) => {
    if (!state || p === state.current) {
      setOpen(false)
      return
    }
    void run(async () => {
      await beforeSwitch()
      await saveThumb()
      await postJson('/api/projects/open', { name: p })
    }, true)
  }

  const list = useMemo(() => {
    if (!state) return { folders: [] as string[], boards: [] as Board[] }
    const stars = new Set(state.starred ?? [])
    const first = (a: string, b: string) => Number(stars.has(b)) - Number(stars.has(a))
    const q = query.trim().toLowerCase()
    const pick = (f: (p: string) => boolean) => ({
      folders: state.folders.filter(f).sort(first),
      boards: state.boards.filter(b => f(b.path)).sort((a, b) => first(a.path, b.path) || b.updated - a.updated),
    })
    if (q) return pick(p => p.toLowerCase().includes(q))
    if (starredView) return pick(p => stars.has(p))
    return pick(p => parent(p) === dir)
  }, [state, dir, query, starredView])

  if (!state)
    return (
      <div className="pj-crumb">
        <b>Devboard</b>
      </div>
    )
  const isBoard = (p: string) => state.boards.some(b => b.path === p)
  const inFolder = (f: string) => state.boards.filter(b => b.path.startsWith(`${f}/`)).length
  const starred = new Set(state.starred ?? [])
  const fullNames = Boolean(query) || starredView
  const goto = (f: string) => {
    setQuery('')
    setStarredView(false)
    setDir(f)
    setExpanded(e => new Set([...e, ...f.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))]))
  }
  // A tap right after a drag is the drag's own release.
  const tap = (f: () => void) => () => {
    if (Date.now() - dropped.current > 300) f()
  }
  const star = (p: string) => {
    const on = !starred.has(p)
    setState(s => s && { ...s, starred: on ? [...(s.starred ?? []), p] : (s.starred ?? []).filter(x => x !== p) })
    void postJson('/api/projects/star', { path: p, on }).catch(e => {
      setError(e instanceof Error ? e.message : String(e))
      void refresh()
    })
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    dropped.current = Date.now()
    setMoving(null)
    const from = active.data.current?.path,
      to = over?.data.current?.folder
    if (typeof from === 'string' && typeof to === 'string' && canMove(from, to)) moveTo(from, to)
  }
  const crumbs = state.current.split('/')

  const submit = () => {
    if (!ask) return
    if (ask.kind === 'board' || ask.kind === 'folder' || ask.kind === 'rename') {
      const name = cleanName(ask.value)
      if (!name) {
        setError('Type a name with letters or digits')
        return
      }
      if (ask.kind === 'rename') {
        const from = ask.target
        void run(() => postJson('/api/projects/move', { from, to: join(parent(from), name) }))
      } else if (ask.kind === 'board')
        void run(async () => {
          await beforeSwitch()
          await saveThumb()
          await postJson('/api/projects/open', { name: join(dir, name) })
        }, true)
      else void run(() => postJson('/api/projects/folder', { path: join(dir, name) }))
    } else if (ask.kind === 'delete') {
      void run(() => postJson('/api/projects/delete', { name: ask.target }))
    }
  }
  const moveTo = (target: string, folder: string) =>
    void run(() => postJson('/api/projects/move', { from: target, to: join(folder, base(target)) }))

  const itemMenu = (p: string) => (
    <div className="pj-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setMenu(null)
          setAsk({ kind: 'rename', target: p, value: base(p) })
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setMenu(null)
          setAsk({ kind: 'move', target: p })
        }}
      >
        Move to…
      </button>
      <button
        type="button"
        role="menuitem"
        className="bad"
        onClick={() => {
          setMenu(null)
          setAsk({ kind: 'delete', target: p })
        }}
      >
        Delete
      </button>
    </div>
  )
  const more = (p: string) => (
    <button
      type="button"
      className="pj-more"
      aria-label={`More for ${base(p)}`}
      aria-expanded={menu === p}
      onClick={e => {
        e.stopPropagation()
        setMenu(m => (m === p ? null : p))
      }}
    >
      <MoreHorizontal size={18} />
    </button>
  )

  const ctx: Ctx = {
    state,
    starred,
    nonce,
    menu,
    dir,
    starredView,
    fullNames,
    expanded,
    inFolder,
    more,
    itemMenu,
    openBoard,
    goto,
    star,
    tap,
    toggle: f =>
      setExpanded(e => {
        const n = new Set(e)
        if (!n.delete(f)) n.add(f)
        return n
      }),
  }

  return (
    <>
      <button type="button" className="pj-crumb" onClick={show} aria-haspopup="dialog" title="All projects">
        {crumbs.slice(0, -1).map(c => (
          <span key={c} className="pj-crumb-dir">
            {c}
            <ChevronRight size={14} />
          </span>
        ))}
        <b>{crumbs.at(-1)}</b>
        <ChevronDown size={16} className="pj-crumb-caret" />
      </button>

      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a tap outside the sheet closes it; Escape does the same (keydown above)
        // biome-ignore lint/a11y/useKeyWithClickEvents: same
        <div
          className="pj-scrim"
          onClick={e => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap anywhere in the sheet folds an open item menu; Escape does the same */}
          <div className="pj-sheet" role="dialog" aria-label="Projects" onClick={() => setMenu(null)}>
            <div className="pj-top">
              <h2>Projects</h2>
              <label className="pj-search">
                <Search size={16} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search all boards" />
              </label>
              <button type="button" className="btn q" onClick={() => setAsk({ kind: 'folder', value: '' })}>
                <FolderPlus size={16} /> New folder
              </button>
              <button type="button" className="btn" onClick={() => setAsk({ kind: 'board', value: '' })}>
                <Plus size={16} /> New board
              </button>
              <button type="button" className="pj-close" onClick={() => setOpen(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>

            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={({ active }) => {
                const p = active.data.current?.path
                setMenu(null)
                setMoving(typeof p === 'string' ? p : null)
              }}
              onDragEnd={onDragEnd}
              onDragCancel={() => {
                dropped.current = Date.now()
                setMoving(null)
              }}
            >
              <div className="pj-body">
                <nav className="pj-tree" aria-label="Folders">
                  <button
                    type="button"
                    className="pj-row-hit pj-row-top"
                    aria-current={starredView && !query ? 'page' : undefined}
                    onClick={() => {
                      setQuery('')
                      setStarredView(true)
                    }}
                  >
                    <Star size={16} className="pj-star-icon" /> <span>Starred</span>
                  </button>
                  <DropCrumb folder="" className="pj-row">
                    <button
                      type="button"
                      className="pj-row-hit pj-row-top"
                      aria-current={!starredView && !query && dir === '' ? 'page' : undefined}
                      onClick={() => goto('')}
                    >
                      <FileIcon size={16} /> <span>All boards</span>
                    </button>
                  </DropCrumb>
                  {state.folders
                    .filter(f => !f.includes('/'))
                    .map(f => (
                      <TreeFolder key={f} c={ctx} f={f} depth={1} />
                    ))}
                  {state.boards
                    .filter(b => !b.path.includes('/'))
                    .map(b => (
                      <TreeBoard key={b.path} c={ctx} path={b.path} depth={1} />
                    ))}
                </nav>

                <div className="pj-main">
                  {!query &&
                    (starredView ? (
                      <nav className="pj-path" aria-label="Folder">
                        <button type="button" aria-current="page">
                          Starred
                        </button>
                      </nav>
                    ) : (
                      <nav className="pj-path" aria-label="Folder">
                        <DropCrumb folder="">
                          <button type="button" aria-current={dir === '' ? 'page' : undefined} onClick={() => goto('')}>
                            All boards
                          </button>
                        </DropCrumb>
                        {dir &&
                          dir.split('/').map((c, i, a) => {
                            const p = a.slice(0, i + 1).join('/')
                            return (
                              <React.Fragment key={p}>
                                <ChevronRight size={14} />
                                <DropCrumb folder={p}>
                                  <button
                                    type="button"
                                    aria-current={p === dir ? 'page' : undefined}
                                    onClick={() => goto(p)}
                                  >
                                    {c}
                                  </button>
                                </DropCrumb>
                              </React.Fragment>
                            )
                          })}
                      </nav>
                    ))}

                  {error && !ask && <div className="pt r pj-error">{error}</div>}

                  <div className="pj-grid">
                    {list.folders.map(f => (
                      <Card key={f} c={ctx} path={f} />
                    ))}
                    {list.boards.map(b => (
                      <Card key={b.path} c={ctx} path={b.path} />
                    ))}
                    {!list.folders.length && !list.boards.length && (
                      <div className="pj-empty">
                        {query
                          ? 'No board or folder has that name.'
                          : starredView
                            ? 'Nothing starred. Tap the star on a card.'
                            : 'This folder is empty. Make a board or drag one here.'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
                {moving && (
                  <div className="pj-ghost">
                    {isBoard(moving) ? <FileIcon size={16} /> : <Folder size={16} />}
                    {base(moving)}
                  </div>
                )}
              </DragOverlay>
            </DndContext>

            {ask && (
              // biome-ignore lint/a11y/noStaticElementInteractions: a tap outside the form cancels; Escape does the same (keydown above)
              // biome-ignore lint/a11y/useKeyWithClickEvents: same
              <div
                className="pj-ask-scrim"
                onClick={e => {
                  if (e.target === e.currentTarget) setAsk(null)
                }}
              >
                <form
                  className="pj-ask"
                  onSubmit={e => {
                    e.preventDefault()
                    submit()
                  }}
                >
                  {error && <div className="pt r">{error}</div>}
                  {ask.kind === 'move' ? (
                    <>
                      <h3>Move "{base(ask.target)}" to</h3>
                      <div className="pj-folders">
                        {['', ...state.folders]
                          .filter(f => !within(f, ask.target) && f !== parent(ask.target))
                          .map(f => (
                            <button
                              type="button"
                              key={f || '/'}
                              style={{ paddingLeft: 12 + (f ? f.split('/').length : 0) * 16 }}
                              onClick={() => moveTo(ask.target, f)}
                              disabled={busy}
                            >
                              <Folder size={16} /> {f ? base(f) : 'All boards'}
                            </button>
                          ))}
                      </div>
                      <div className="pj-ask-row">
                        <button type="button" className="btn q" onClick={() => setAsk(null)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : ask.kind === 'delete' ? (
                    <>
                      <h3>Delete "{base(ask.target)}"?</h3>
                      <p>
                        {isBoard(ask.target) ? 'The board' : 'The folder and every board in it'} moves to the trash
                        folder on the Mac.
                      </p>
                      <div className="pj-ask-row">
                        <button type="button" className="btn q" onClick={() => setAsk(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="btn bad" disabled={busy}>
                          Delete
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>
                        {ask.kind === 'rename'
                          ? `Rename "${base(ask.target)}"`
                          : ask.kind === 'board'
                            ? 'New board'
                            : 'New folder'}
                      </h3>
                      {ask.kind !== 'rename' && <p>In {dir || 'All boards'}</p>}
                      <input
                        // biome-ignore lint/a11y/noAutofocus: the dialog just opened; focus belongs in its one field
                        autoFocus
                        value={ask.value}
                        onChange={e => setAsk({ ...ask, value: e.target.value })}
                        placeholder="Name"
                        maxLength={48}
                      />
                      <div className="pj-ask-row">
                        <button type="button" className="btn q" onClick={() => setAsk(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="btn" disabled={busy || !cleanName(ask.value)}>
                          {ask.kind === 'rename' ? 'Rename' : 'Make'}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
