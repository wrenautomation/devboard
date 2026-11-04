// Local patch: every Excalidraw color row (stroke, background, canvas background) becomes one row of quick picks
// and a custom swatch, the system color picker. It takes the place of Excalidraw's fixed picks and its palette
// popover: same height, more colors. Swatches reuse Excalidraw's classes, so size, checkerboard and dark-mode
// filter match.

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { type CSSProperties, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { restyle } from './edits'
import { useSlots } from './slots'

type Kind = 'stroke' | 'background' | 'canvas'
type Capture = 'EVENTUALLY' | 'IMMEDIATELY'

// Open-color shades, as Excalidraw's own picks. Purple = grape.
const PICKS: Record<Kind, string[]> = {
  stroke: ['#1e1e1e', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5'],
  background: ['transparent', '#ffc9c9', '#ffec99', '#b2f2bb', '#a5d8ff', '#eebefa'],
  canvas: ['#ffffff', '#f8f9fa', '#f5faff', '#fffce8', '#fdf8f6'],
}
// Excalidraw's label on each row's popover button names the row.
const KIND_OF: Record<string, Kind> = { Stroke: 'stroke', Background: 'background', 'Canvas background': 'canvas' }

const read = (s: AppState, el: ExcalidrawElement | undefined): Record<Kind, string> => ({
  stroke: el ? el.strokeColor : s.currentItemStrokeColor,
  background: el ? el.backgroundColor : s.currentItemBackgroundColor,
  canvas: s.viewBackgroundColor,
})

const set = (api: ExcalidrawImperativeAPI, kind: Kind, c: string, capture: Capture) =>
  kind === 'stroke'
    ? restyle(api, { currentItemStrokeColor: c }, { strokeColor: c }, capture)
    : kind === 'background'
      ? restyle(api, { currentItemBackgroundColor: c }, { backgroundColor: c }, capture)
      : restyle(api, { viewBackgroundColor: c }, null, capture)

// The color input takes #rrggbb only.
const hex6 = (c: string) =>
  /^#[0-9a-f]{6}$/i.test(c) ? c : /^#[0-9a-f]{3}$/i.test(c) ? `#${[...c.slice(1)].map(d => d + d).join('')}` : '#000000'

const kindOf = (slot: HTMLElement) =>
  KIND_OF[slot.parentElement?.querySelector('.color-picker-container .active-color')?.getAttribute('aria-label') ?? '']

export function Colors({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const slots = useSlots('div:has(> .color-picker-container)', 'cp-slot')
  const [now, setNow] = useState<Record<Kind, string>>({ stroke: '', background: '', canvas: '' })

  useEffect(() => {
    if (!api) return
    const sync = () => {
      const s = api.getAppState()
      const id = Object.keys(s.selectedElementIds)[0]
      const next = read(s, id ? api.getSceneElements().find(e => e.id === id) : undefined)
      setNow(prev =>
        prev.stroke === next.stroke && prev.background === next.background && prev.canvas === next.canvas ? prev : next,
      )
    }
    sync()
    return api.onChange(sync)
  }, [api])

  if (!api) return null
  return (
    <>
      {slots.map(slot => {
        const kind = kindOf(slot)
        return kind ? createPortal(<Row api={api} kind={kind} color={now[kind]} />, slot, kind) : null
      })}
    </>
  )
}

function Row({ api, kind, color }: { api: ExcalidrawImperativeAPI; kind: Kind; color: string }) {
  const picks = PICKS[kind]
  const custom = !picks.some(p => p.toLowerCase() === color.toLowerCase())
  return (
    <div className="cp-row">
      {picks.map(p => (
        <button
          key={p}
          type="button"
          className={`color-picker__button${p === 'transparent' ? ' is-transparent' : ''}${p.toLowerCase() === color.toLowerCase() ? ' active' : ''}`}
          style={{ '--swatch-color': p } as CSSProperties}
          title={p}
          aria-label={p}
          aria-pressed={p.toLowerCase() === color.toLowerCase()}
          onClick={() => set(api, kind, p, 'IMMEDIATELY')}
        >
          <div className="color-picker__button-outline" />
        </button>
      ))}
      <label
        className={`color-picker__button cp-custom${custom ? ' active' : ''}`}
        style={{ '--swatch-color': custom ? color : 'transparent' } as CSSProperties}
        title="Custom color"
      >
        {/* Live while the picker is open; the change on close commits one undo step. */}
        <input
          type="color"
          aria-label="Custom color"
          value={hex6(color)}
          onChange={e => set(api, kind, e.currentTarget.value, 'EVENTUALLY')}
          ref={el => {
            if (el && !el.dataset.bound) {
              el.dataset.bound = '1'
              el.addEventListener('change', () => set(api, kind, el.value, 'IMMEDIATELY'))
            }
          }}
        />
        <div className="color-picker__button-outline" />
      </label>
    </div>
  )
}
