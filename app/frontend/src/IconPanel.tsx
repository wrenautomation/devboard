// Local patch: Icons panel. Searchable, by category, over the canvas's pack (/lib/wren.excalidrawlib).
// Tap an item to drop it at the middle of the view, or drag it sideways onto the canvas (no long press).
// Excalidraw 0.18's own library has no search.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { exportToSvg, restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

type PackItem = { id: string; name: string; category: string; tags?: string; elements: any[] }

let packPromise: Promise<PackItem[]> | null = null
const loadPack = () =>
  (packPromise ??= fetch('/lib/wren.excalidrawlib')
    .then(r => (r.ok ? r.json() : { libraryItems: [] }))
    .then(d => d.libraryItems as PackItem[])
    .catch(() => { packPromise = null; return [] }))

const previews = new Map<string, Promise<string>>()
const preview = (item: PackItem): Promise<string> => {
  const cached = previews.get(item.id)
  if (cached) return cached
  const made: Promise<string> = exportToSvg({
    elements: restoreElements(item.elements, null),
    appState: { exportBackground: false, exportPadding: 4 },
    files: null,
    skipInliningFonts: true,
  }).then((svg: SVGSVGElement) => svg.outerHTML).catch(() => '')
  previews.set(item.id, made)
  return made
}

// A typed word also matches these (so "database" finds "Relational DB").
const SYNONYMS: Record<string, string[]> = {
  database: ['db', 'sql', 'postgres', 'storage'], db: ['database', 'sql', 'postgres'],
  lb: ['load balancer'], queue: ['message q', 'kafka', 'stream'], cache: ['redis'],
  user: ['person', 'people', 'stick', 'users'], person: ['user', 'stick'], people: ['user', 'person', 'stick'],
  email: ['mail', 'gmail', 'inbox'], mail: ['email'], ads: ['google ads', 'meta'], ad: ['ads'],
  payment: ['stripe', 'paypal', 'wise', 'pay'], pay: ['payment', 'stripe'], crm: ['hubspot', 'sales'],
  note: ['post it', 'sticky'], sticky: ['post it', 'note'], video: ['youtube', 'tiktok', 'loom'],
  ai: ['openai', 'anthropic', 'claude', 'perplexity', 'llm'], llm: ['openai', 'anthropic', 'claude'],
  phone: ['mobile', 'device', 'twilio', 'sms'], sms: ['twilio', 'text'], booking: ['cal.com', 'calendly'],
  website: ['web app', 'webflow', 'wordpress', 'framer'], decision: ['condition', 'yes no'],
}

type Drop = { x: number; y: number }

// Sideways drag past 8px starts a drag; a vertical move stays a list scroll (touch-action: pan-y).
function Tile({ item, onPick }: { item: PackItem; onPick: (i: PackItem, at?: Drop) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const dragged = useRef(false)
  const [svg, setSvg] = useState('')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { io.disconnect(); void preview(item).then(setSvg) }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [item])

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const x0 = e.clientX, y0 = e.clientY
    let ghost: HTMLDivElement | null = null
    dragged.current = false
    const move = (m: PointerEvent) => {
      if (!ghost) {
        const dx = Math.abs(m.clientX - x0), dy = Math.abs(m.clientY - y0)
        if (dx < 8 || dx < dy) return
        ghost = document.createElement('div')
        ghost.className = 'icon-ghost'
        ghost.innerHTML = svg
        document.body.appendChild(ghost)
        dragged.current = true
      }
      ghost.style.left = `${m.clientX}px`
      ghost.style.top = `${m.clientY}px`
    }
    const end = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (!ghost) return
      ghost.remove()
      const over = document.elementFromPoint(u.clientX, u.clientY)
      if (u.type === 'pointerup' && !over?.closest('.icon-panel')) onPick(item, { x: u.clientX, y: u.clientY })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <button ref={ref} className="icon-tile" title={item.name} onPointerDown={down}
      onClick={() => { if (!dragged.current) onPick(item); dragged.current = false }}>
      <span className="icon-art" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="icon-name">{item.name}</span>
    </button>
  )
}

const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4)

// Copies an item with fresh ids (groups, text containers and arrow bindings remapped) centred at x,y.
function cloneAt(elements: any[], cx: number, cy: number) {
  const ids = new Map<string, string>(), groups = new Map<string, string>()
  const id = (old: string) => { if (!ids.has(old)) ids.set(old, newId()); return ids.get(old)! }
  const gid = (old: string) => { if (!groups.has(old)) groups.set(old, newId()); return groups.get(old)! }
  const x0 = Math.min(...elements.map(e => e.x)), y0 = Math.min(...elements.map(e => e.y))
  const x1 = Math.max(...elements.map(e => e.x + (e.width || 0))), y1 = Math.max(...elements.map(e => e.y + (e.height || 0)))
  const dx = cx - (x0 + x1) / 2, dy = cy - (y0 + y1) / 2
  const known = new Set(elements.map(e => e.id))
  const keep = (old?: string | null) => (old && known.has(old) ? id(old) : null)
  return elements.map(e => ({
    ...e,
    id: id(e.id),
    x: e.x + dx,
    y: e.y + dy,
    groupIds: (e.groupIds || []).map(gid),
    frameId: null,
    containerId: keep(e.containerId),
    boundElements: e.boundElements?.filter((b: any) => known.has(b.id)).map((b: any) => ({ ...b, id: id(b.id) })) ?? null,
    startBinding: e.startBinding && known.has(e.startBinding.elementId) ? { ...e.startBinding, elementId: id(e.startBinding.elementId) } : null,
    endBinding: e.endBinding && known.has(e.endBinding.elementId) ? { ...e.endBinding, elementId: id(e.endBinding.elementId) } : null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
    isDeleted: false,
    locked: false,
  }))
}

export function IconPanel({ api, onClose }: { api: ExcalidrawImperativeAPI | null; onClose: () => void }) {
  const [items, setItems] = useState<PackItem[]>([])
  const [query, setQuery] = useState(() => { try { return sessionStorage.getItem('icons-query') || '' } catch { return '' } })
  const [category, setCategory] = useState<string>(() => { try { return sessionStorage.getItem('icons-category') || '' } catch { return '' } })
  useEffect(() => { void loadPack().then(setItems) }, [])
  useEffect(() => {
    try { sessionStorage.setItem('icons-query', query); sessionStorage.setItem('icons-category', category) } catch { /* private mode */ }
  }, [query, category])

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) counts.set(i.category, (counts.get(i.category) || 0) + 1)
    return [...counts]
  }, [items])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter(i => {
      if (!words.length) return !category || i.category === category
      const hay = `${i.name} ${i.category} ${i.tags || ''}`.toLowerCase()
      return words.every(w => hay.includes(w) || (SYNONYMS[w] || []).some(x => hay.includes(x)))
    }).sort((a, b) => {
      if (!words.length) return 0
      const starts = (i: PackItem) => {
        const n = i.name.toLowerCase(), w = words[0]!
        return n.startsWith(w) ? 0 : n.includes(w) ? 1 : (SYNONYMS[w] || []).some(x => n.includes(x)) ? 2 : 3
      }
      return starts(a) - starts(b)
    })
  }, [items, query, category])

  // With no search, show items under their category headings; a search shows one flat list.
  const sections = useMemo(() => {
    if (query.trim()) return [['', shown] as const]
    const by = new Map<string, PackItem[]>()
    for (const i of shown) by.set(i.category, [...(by.get(i.category) || []), i])
    return [...by]
  }, [shown, query])

  // at = the drop point on screen; none = the middle of the view.
  const pick = (item: PackItem, at?: Drop) => {
    if (!api) return
    const s = api.getAppState()
    const zoom = s.zoom.value
    const sx = at ? at.x - s.offsetLeft : s.width / 2, sy = at ? at.y - s.offsetTop : s.height / 2
    const cx = sx / zoom - s.scrollX, cy = sy / zoom - s.scrollY
    const added = restoreElements(cloneAt(item.elements, cx, cy), null)
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...added],
      appState: { selectedElementIds: Object.fromEntries(added.map(e => [e.id, true])) as any },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }

  return (
    <aside className="icon-panel" aria-label="Icons">
      <div className="icon-panel-top">
        <input
          className="icon-search"
          type="search"
          placeholder={`Search ${items.length} icons`}
          value={query}
          onChange={e => { setQuery(e.target.value); if (e.target.value) setCategory('') }}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button className="icon-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="icon-cats">
        <button className={!category ? 'on' : ''} onClick={() => setCategory('')}>All</button>
        {categories.map(([c, n]) => (
          <button key={c} className={category === c ? 'on' : ''} onClick={() => { setQuery(''); setCategory(category === c ? '' : c) }}>
            {c} <span>{n}</span>
          </button>
        ))}
      </div>
      <div className="icon-list">
        {!shown.length && items.length > 0 && <p className="icon-empty">Nothing matches "{query}".</p>}
        {sections.map(([title, list]) => (
          <section key={title || 'results'}>
            {title && <h3>{title}</h3>}
            <div className="icon-grid">
              {list.map(i => <Tile key={i.id} item={i} onPick={pick} />)}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}
