// Local patch: stroke width control. Excalidraw's own picker has three fixed widths; this adds a
// thinner preset and a slider for any width. Sets the pen default and the selected shapes.
import React, { useEffect, useState } from 'react'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

const PRESETS: [number, string][] = [[0.5, 'Fine'], [1, 'Thin'], [2, 'Bold'], [4, 'Heavy']]
const MIN = 0.25, MAX = 10

export function StrokeWidth({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(2)

  // Follow the selection, or the pen default when nothing is selected.
  useEffect(() => {
    if (!api) return
    const read = () => {
      const s = api.getAppState()
      const ids = Object.keys(s.selectedElementIds)
      const el = ids.length ? api.getSceneElements().find(e => e.id === ids[0]) : undefined
      setWidth(el ? el.strokeWidth : s.currentItemStrokeWidth)
    }
    read()
    return api.onChange(read)
  }, [api])

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
    <div className="stroke-width">
      <button className="sw-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>Width {width}</button>
      {open && (
        <div className="sw-pop">
          <div className="sw-presets">
            {PRESETS.map(([w, label]) => (
              <button key={w} className={width === w ? 'on' : ''} onClick={() => apply(w)} title={`${label} (${w})`}>
                <span className="sw-line" style={{ height: Math.max(1, w * 2) }} />
                <span className="sw-name">{label}</span>
              </button>
            ))}
          </div>
          <div className="sw-custom">
            <input type="range" min={MIN} max={MAX} step={0.25} value={width} onChange={e => apply(Number(e.target.value))} aria-label="Stroke width" />
            <input type="number" min={MIN} max={MAX} step={0.25} value={width} onChange={e => e.target.value && apply(Number(e.target.value))} aria-label="Stroke width number" />
          </div>
        </div>
      )}
    </div>
  )
}
