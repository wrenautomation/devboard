// Local patch: Projects view. Boards live in folders (paths like clients/acme/flow), like the Files app:
// a breadcrumb, folders first, then boards with a thumbnail. Each item has Rename, Move and Delete.
// The server does the work (/api/projects*); every tab gets projects_changed and refreshes.
import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderPlus, LayoutDashboard, MoreHorizontal, Plus, Search, X } from 'lucide-react'

type Board = { path: string; updated: number; thumb: boolean }
type State = { current: string; boards: Board[]; folders: string[] }
type Ask =
  | { kind: 'board' | 'folder'; value: string }
  | { kind: 'rename'; target: string; value: string }
  | { kind: 'move'; target: string }
  | { kind: 'delete'; target: string }

const postJson = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}
const parent = (p: string) => p.split('/').slice(0, -1).join('/')
const base = (p: string) => p.split('/').pop()!
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const within = (p: string, root: string) => p === root || p.startsWith(root + '/')
// What the server takes: letters, digits, spaces, dashes, underscores.
const cleanName = (typed: string) => typed.trim().replace(/[^A-Za-z0-9 _-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48).trim()
const ago = (ms: number) => {
  if (!ms) return 'Empty'
  const s = (Date.now() - ms) / 1000, rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (s < 60) return 'Edited just now'
  // unit, its seconds, how many before the next unit
  for (const [unit, n, max] of [['minute', 60, 60], ['hour', 3600, 24], ['day', 86400, 7], ['week', 604800, 5]] as const) {
    if (s < n * max) return `Edited ${rtf.format(-Math.floor(s / n), unit)}`
  }
  return `Edited ${new Date(ms).toLocaleDateString()}`
}

export function Projects({ beforeSwitch, saveThumb }: { beforeSwitch: () => Promise<void>; saveThumb: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null)
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState('')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0) // busts the open board's thumbnail after it is saved again

  const refresh = () => fetch('/api/projects').then(r => (r.ok ? r.json() : null)).then(d => d && setState(d)).catch(() => {})
  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener('canvas-project', onChange)
    window.addEventListener('canvas-projects-changed', onChange)
    return () => {
      window.removeEventListener('canvas-project', onChange)
      window.removeEventListener('canvas-projects-changed', onChange)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (ask) setAsk(null); else if (menu) setMenu(null); else setOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, ask, menu])

  const show = () => {
    if (!state) return
    setDir(parent(state.current)); setQuery(''); setMenu(null); setAsk(null); setError(''); setOpen(true)
    void saveThumb().then(() => { setNonce(n => n + 1); return refresh() })
  }
  const run = async (work: () => Promise<unknown>, close = false) => {
    setBusy(true); setError('')
    try { await work(); setAsk(null); if (close) setOpen(false) } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false); void refresh() }
  }
  const openBoard = (p: string) => {
    if (!state || p === state.current) { setOpen(false); return }
    void run(async () => { await beforeSwitch(); await saveThumb(); await postJson('/api/projects/open', { name: p }) }, true)
  }

  const list = useMemo(() => {
    if (!state) return { folders: [] as string[], boards: [] as Board[] }
    const q = query.trim().toLowerCase()
    if (q) {
      return {
        folders: state.folders.filter(f => f.toLowerCase().includes(q)),
        boards: state.boards.filter(b => b.path.toLowerCase().includes(q)).sort((a, b) => b.updated - a.updated),
      }
    }
    return {
      folders: state.folders.filter(f => parent(f) === dir),
      boards: state.boards.filter(b => parent(b.path) === dir).sort((a, b) => b.updated - a.updated),
    }
  }, [state, dir, query])

  if (!state) return <div className="pj-crumb"><span className="wm" aria-hidden /> <b>Devboard</b></div>
  const isBoard = (p: string) => state.boards.some(b => b.path === p)
  const inFolder = (f: string) => state.boards.filter(b => b.path.startsWith(f + '/')).length
  const crumbs = state.current.split('/')

  const submit = () => {
    if (!ask) return
    if (ask.kind === 'board' || ask.kind === 'folder' || ask.kind === 'rename') {
      const name = cleanName(ask.value)
      if (!name) { setError('Type a name with letters or digits'); return }
      if (ask.kind === 'rename') { const from = ask.target; void run(() => postJson('/api/projects/move', { from, to: join(parent(from), name) })) }
      else if (ask.kind === 'board') void run(async () => { await beforeSwitch(); await saveThumb(); await postJson('/api/projects/open', { name: join(dir, name) }) }, true)
      else void run(() => postJson('/api/projects/folder', { path: join(dir, name) }))
    } else if (ask.kind === 'delete') {
      void run(() => postJson('/api/projects/delete', { name: ask.target }))
    }
  }
  const moveTo = (target: string, folder: string) =>
    void run(() => postJson('/api/projects/move', { from: target, to: join(folder, base(target)) }))

  const itemMenu = (p: string) => (
    <div className="pj-menu" role="menu" onClick={e => e.stopPropagation()}>
      <button role="menuitem" onClick={() => { setMenu(null); setAsk({ kind: 'rename', target: p, value: base(p) }) }}>Rename</button>
      <button role="menuitem" onClick={() => { setMenu(null); setAsk({ kind: 'move', target: p }) }}>Move to…</button>
      <button role="menuitem" className="bad" onClick={() => { setMenu(null); setAsk({ kind: 'delete', target: p }) }}>Delete</button>
    </div>
  )
  const more = (p: string) => (
    <button className="pj-more" aria-label={`More for ${base(p)}`} aria-expanded={menu === p}
      onClick={e => { e.stopPropagation(); setMenu(m => (m === p ? null : p)) }}><MoreHorizontal size={18} /></button>
  )

  return (
    <>
      <button className="pj-crumb" onClick={show} aria-haspopup="dialog" title="All projects">
        <span className="wm" aria-hidden />
        {crumbs.slice(0, -1).map(c => <span key={c} className="pj-crumb-dir">{c}<ChevronRight size={14} /></span>)}
        <b>{crumbs.at(-1)}</b>
        <ChevronDown size={16} className="pj-crumb-caret" />
      </button>

      {open && (
        <div className="pj-scrim" onClick={() => setOpen(false)}>
          <div className="pj-sheet" role="dialog" aria-label="Projects" onClick={e => { e.stopPropagation(); setMenu(null) }}>
            <div className="pj-top">
              <h2>Projects</h2>
              <label className="pj-search"><Search size={16} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search all boards" />
              </label>
              <button className="btn q" onClick={() => setAsk({ kind: 'folder', value: '' })}><FolderPlus size={16} /> New folder</button>
              <button className="btn" onClick={() => setAsk({ kind: 'board', value: '' })}><Plus size={16} /> New board</button>
              <button className="pj-close" onClick={() => setOpen(false)} aria-label="Close"><X size={20} /></button>
            </div>

            {!query && (
              <nav className="pj-path" aria-label="Folder">
                <button aria-current={dir === '' ? 'page' : undefined} onClick={() => setDir('')}>All boards</button>
                {dir && dir.split('/').map((c, i, a) => {
                  const p = a.slice(0, i + 1).join('/')
                  return <React.Fragment key={p}><ChevronRight size={14} /><button aria-current={p === dir ? 'page' : undefined} onClick={() => setDir(p)}>{c}</button></React.Fragment>
                })}
              </nav>
            )}

            {error && !ask && <div className="pt r pj-error">{error}</div>}

            <div className="pj-grid">
              {list.folders.map(f => (
                <div key={f} className="pj-card pj-folder">
                  <button className="pj-hit" onClick={() => { setQuery(''); setDir(f) }}>
                    <div className="pj-art"><Folder size={44} strokeWidth={1.4} /></div>
                    <div className="pj-meta"><b>{query ? f : base(f)}</b><span>{inFolder(f) === 1 ? '1 board' : `${inFolder(f)} boards`}</span></div>
                  </button>
                  {more(f)}
                  {menu === f && itemMenu(f)}
                </div>
              ))}
              {list.boards.map(b => (
                <div key={b.path} className={`pj-card ${b.path === state.current ? 'on' : ''}`}>
                  <button className="pj-hit" onClick={() => openBoard(b.path)} aria-current={b.path === state.current ? 'true' : undefined}>
                  <div className="pj-art">
                    {b.thumb
                      ? <img src={`/api/projects/thumb?path=${encodeURIComponent(b.path)}&v=${b.updated}-${b.path === state.current ? nonce : 0}`} alt="" loading="lazy" />
                      : <LayoutDashboard size={40} strokeWidth={1.4} />}
                  </div>
                  <div className="pj-meta">
                    <b>{query ? b.path : base(b.path)}</b>
                    <span>{b.path === state.current ? 'Open now' : ago(b.updated)}</span>
                  </div>
                  </button>
                  {more(b.path)}
                  {menu === b.path && itemMenu(b.path)}
                </div>
              ))}
              {!list.folders.length && !list.boards.length && (
                <div className="pj-empty">{query ? 'No board or folder has that name.' : 'This folder is empty. Make a board or move one here.'}</div>
              )}
            </div>

            {ask && (
              <div className="pj-ask-scrim" onClick={() => setAsk(null)}>
                <form className="pj-ask" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); submit() }}>
                  {error && <div className="pt r">{error}</div>}
                  {ask.kind === 'move' ? (
                    <>
                      <h3>Move "{base(ask.target)}" to</h3>
                      <div className="pj-folders">
                        {['', ...state.folders].filter(f => !within(f, ask.target) && f !== parent(ask.target)).map(f => (
                          <button type="button" key={f || '/'} style={{ paddingLeft: 12 + (f ? f.split('/').length : 0) * 16 }} onClick={() => moveTo(ask.target, f)} disabled={busy}>
                            <Folder size={16} /> {f ? base(f) : 'All boards'}
                          </button>
                        ))}
                      </div>
                      <div className="pj-ask-row"><button type="button" className="btn q" onClick={() => setAsk(null)}>Cancel</button></div>
                    </>
                  ) : ask.kind === 'delete' ? (
                    <>
                      <h3>Delete "{base(ask.target)}"?</h3>
                      <p>{isBoard(ask.target) ? 'The board' : 'The folder and every board in it'} moves to the trash folder on the Mac.</p>
                      <div className="pj-ask-row">
                        <button type="button" className="btn q" onClick={() => setAsk(null)}>Cancel</button>
                        <button className="btn bad" disabled={busy}>Delete</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>{ask.kind === 'rename' ? `Rename "${base(ask.target)}"` : ask.kind === 'board' ? 'New board' : 'New folder'}</h3>
                      {ask.kind !== 'rename' && <p>In {dir || 'All boards'}</p>}
                      <input autoFocus value={ask.value} onChange={e => setAsk({ ...ask, value: e.target.value })} placeholder="Name" maxLength={48} />
                      <div className="pj-ask-row">
                        <button type="button" className="btn q" onClick={() => setAsk(null)}>Cancel</button>
                        <button className="btn" disabled={busy || !cleanName(ask.value)}>{ask.kind === 'rename' ? 'Rename' : 'Make'}</button>
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
