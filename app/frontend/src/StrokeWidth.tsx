// Local patch: the Style button and stroke width. One button at the top right opens or folds Excalidraw's
// style panel (the choice is remembered); it shows only when there is something to style: a selection, or a
// tool that draws. The width row replaces Excalidraw's three fixed widths inside that panel: four presets
// and a slider for any width. It sets the pen default and the selected shapes.
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { ChevronDown } from 'lucide-react'

const PRESETS: [number, string][] = [[0.5, 'Fine'], [1, 'Thin'], [2, 'Bold'], [4, 'Heavy']]
const MIN = 0.25, MAX = 10
const NOTHING_TO_STYLE = new Set(['selection', 'lasso', 'hand', 'eraser', 'laser'])

const remembered = () => { try { return window.localStorage?.getItem('canvas-style-hidden') === '1' } catch { return false } }

export function StrokeWidth({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const [width, setWidth] = useState(0.5)
  const [color, setColor] = useState('#1e1e1e')
  const [shown, setShown] = useState(false)
  const [hidden, setHidden] = useState(remembered)
  const [slot, setSlot] = useState<HTMLElement | null>(null)

  // Follow the selection, or the pen default when nothing is selected.
  useEffect(() => {
    if (!api) return
    const read = () => {
      const s = api.getAppState()
      const ids = Object.keys(s.selectedElementIds)
      const el = ids.length ? api.getSceneElements().find(e => e.id === ids[0]) : undefined
      setWidth(el ? el.strokeWidth : s.currentItemStrokeWidth)
      setColor(el ? el.strokeColor : s.currentItemStrokeColor)
      document.documentElement.dataset.styleSel = ids.length ? '1' : '0'
      setShown(!s.viewModeEnabled && (ids.length > 0 || !NOTHING_TO_STYLE.has(s.activeTool.type)))
    }
    read()
    return api.onChange(read)
  }, [api])

  // Excalidraw mounts its panel per selection and tool; put the width row in its stroke width fieldset each time.
  useEffect(() => {
    const find = () => {
      const set = document.querySelector('.selected-shape-actions fieldset:has(input[name="stroke-width"])')
      let el = set?.querySelector<HTMLElement>(':scope > .sw-slot') ?? null
      if (set && !el) { el = document.createElement('div'); el.className = 'sw-slot'; set.appendChild(el) }
      setSlot(prev => (prev === el ? prev : el))
    }
    find()
    const mo = new MutationObserver(find)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.styleHidden = hidden ? '1' : '0'
    try { window.localStorage?.setItem('canvas-style-hidden', hidden ? '1' : '0') } catch { /* private mode */ }
  }, [hidden])

  const apply = (w: number) => {
    if (!api) return
    const value = Math.min(MAX, Math.max(MIN, Math.round(w * 100) / 100))
    setWidth(value)
    const picked = api.getAppState().selectedElementIds
    api.updateScene({
      appState: { currentItemStrokeWidth: value },
      elements: api.getSceneElementsIncludingDeleted().map(e => picked[e.id] && !e.isDeleted
        ? { ...e, strokeWidth: value, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
        : e) as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }

  return (
    <>
      {shown && (
        <button className="style-toggle" onClick={() => setHidden(h => !h)} aria-expanded={!hidden} aria-label="Style">
          <span className="st-swatch" style={{ background: color }} />
          <span className="st-line" style={{ height: Math.min(8, Math.max(1, width * 1.5)) }} />
          <span>Style</span>
          <ChevronDown size={16} className="st-chev" />
        </button>
      )}
      {slot && createPortal(
        <div className="sw-row">
          <div className="sw-presets">
            {PRESETS.map(([w, label]) => (
              <button key={w} type="button" className={width === w ? 'on' : ''} onClick={() => apply(w)} title={`${label} (${w})`} aria-label={label}>
                <span className="sw-line" style={{ height: Math.max(1, w * 1.5) }} />
              </button>
            ))}
          </div>
          <div className="sw-custom">
            <input type="range" min={MIN} max={MAX} step={0.25} value={width} onChange={e => apply(Number(e.target.value))} aria-label="Stroke width" />
            <span className="sw-val">{width}</span>
          </div>
        </div>,
        slot,
      )}
    </>
  )
}
