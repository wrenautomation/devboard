// Local patch: Icons panel. Searchable, by category, over the canvas's pack (/lib/wren.excalidrawlib).
// Tap an item to drop it at the middle of the view, or drag it sideways onto the canvas (no long press).
// Excalidraw 0.18's own library has no search.

import { exportToSvg, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type Drop, placeOnCanvas } from './place'

type PackItem = { id: string; name: string; category: string; tags?: string; elements: readonly ExcalidrawElement[] }

let packPromise: Promise<PackItem[]> | null = null
const loadPack = () =>
  (packPromise ??= fetch('/lib/wren.excalidrawlib')
    .then(r => (r.ok ? r.json() : { libraryItems: [] }))
    .then(d => d.libraryItems as PackItem[])
    .catch(() => {
      packPromise = null
      return []
    }))

const previews = new Map<string, Promise<string>>()
const preview = (item: PackItem): Promise<string> => {
  const cached = previews.get(item.id)
  if (cached) return cached
  const made: Promise<string> = exportToSvg({
    elements: restoreElements(item.elements, null),
    appState: { exportBackground: false, exportPadding: 4 },
    files: null,
    skipInliningFonts: true,
  })
    .then((svg: SVGSVGElement) => svg.outerHTML)
    .catch(() => '')
  previews.set(item.id, made)
  return made
}

// A typed word also matches these (so "database" finds "Relational DB").
const SYNONYMS: Record<string, string[]> = {
  database: ['db', 'sql', 'postgres', 'storage'],
  db: ['database', 'sql', 'postgres'],
  lb: ['load balancer'],
  queue: ['message q', 'kafka', 'stream'],
  cache: ['redis'],
  user: ['person', 'people', 'stick', 'users'],
  person: ['user', 'stick'],
  people: ['user', 'person', 'stick'],
  email: ['mail', 'gmail', 'inbox'],
  mail: ['email'],
  ads: ['google ads', 'meta'],
  ad: ['ads'],
  payment: ['stripe', 'paypal', 'wise', 'pay'],
  pay: ['payment', 'stripe'],
  crm: ['hubspot', 'sales'],
  note: ['post it', 'sticky'],
  sticky: ['post it', 'note'],
  video: ['youtube', 'tiktok', 'loom'],
  ai: ['openai', 'anthropic', 'claude', 'perplexity', 'llm'],
  llm: ['openai', 'anthropic', 'claude'],
  phone: ['mobile', 'device', 'twilio', 'sms'],
  sms: ['twilio', 'text'],
  booking: ['cal.com', 'calendly'],
  website: ['web app', 'webflow', 'wordpress', 'framer'],
  decision: ['condition', 'yes no'],
}

// Finger: a sideways drag past 8px starts a drag; a vertical move stays a list scroll (touch-action: pan-y). Pen: any move past 6px.
function Tile({ item, onPick }: { item: PackItem; onPick: (i: PackItem, at?: Drop) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const dragged = useRef(false)
  const [svg, setSvg] = useState('')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          io.disconnect()
          void preview(item).then(setSvg)
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [item])

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // A pen does not scroll the list: any move drags. preventDefault stops Safari taking the stroke for a scroll or text select.
    const pen = e.pointerType === 'pen'
    if (pen) {
      e.preventDefault()
      try {
        ref.current?.setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }
    const x0 = e.clientX,
      y0 = e.clientY
    let ghost: HTMLDivElement | null = null
    dragged.current = false
    const move = (m: PointerEvent) => {
      if (!ghost) {
        const dx = Math.abs(m.clientX - x0),
          dy = Math.abs(m.clientY - y0)
        if (pen ? Math.hypot(dx, dy) < 6 : dx < 8 || dx < dy) return
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
    <button
      type="button"
      ref={ref}
      className="icon-tile"
      title={item.name}
      onPointerDown={down}
      onClick={() => {
        if (!dragged.current) onPick(item)
        dragged.current = false
      }}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG comes from Excalidraw's own exporter over the local pack */}
      <span className="icon-art" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="icon-name">{item.name}</span>
    </button>
  )
}

export function IconPanel({ api, onClose }: { api: ExcalidrawImperativeAPI | null; onClose: () => void }) {
  const [items, setItems] = useState<PackItem[]>([])
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem('icons-query') || ''
    } catch {
      return ''
    }
  })
  const [category, setCategory] = useState<string>(() => {
    try {
      return sessionStorage.getItem('icons-category') || ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    void loadPack().then(setItems)
  }, [])
  useEffect(() => {
    try {
      sessionStorage.setItem('icons-query', query)
      sessionStorage.setItem('icons-category', category)
    } catch {
      /* private mode */
    }
  }, [query, category])

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) counts.set(i.category, (counts.get(i.category) || 0) + 1)
    return [...counts]
  }, [items])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return items
      .filter(i => {
        if (!words.length) return !category || i.category === category
        const hay = `${i.name} ${i.category} ${i.tags || ''}`.toLowerCase()
        return words.every(w => hay.includes(w) || (SYNONYMS[w] || []).some(x => hay.includes(x)))
      })
      .sort((a, b) => {
        if (!words.length) return 0
        const starts = (i: PackItem) => {
          const n = i.name.toLowerCase(),
            w = words[0]
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

  const pick = (item: PackItem, at?: Drop) => {
    if (api) placeOnCanvas(api, item.elements, at)
  }

  return (
    <aside className="icon-panel" aria-label="Icons">
      <div className="icon-panel-top">
        <input
          className="icon-search"
          type="search"
          placeholder={`Search ${items.length} icons`}
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            if (e.target.value) setCategory('')
          }}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="button" className="icon-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="icon-cats">
        <button type="button" className={!category ? 'on' : ''} onClick={() => setCategory('')}>
          All
        </button>
        {categories.map(([c, n]) => (
          <button
            type="button"
            key={c}
            className={category === c ? 'on' : ''}
            onClick={() => {
              setQuery('')
              setCategory(category === c ? '' : c)
            }}
          >
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
              {list.map(i => (
                <Tile key={i.id} item={i} onPick={pick} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}
