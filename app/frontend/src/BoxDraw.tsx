// Local patch: drag a box over the canvas. Used by Mark area (Send to Claude) and Scratch.

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type React from 'react'
import { useState } from 'react'
import { type Box, boxStyle, toScene } from './view'

// Full-screen layer. onDone gets the box in scene coords; a box under 12px is ignored.
export function BoxDraw({
  api,
  hint,
  onDone,
  onCancel,
}: {
  api: ExcalidrawImperativeAPI
  hint: string
  onDone: (scene: Box) => void
  onCancel: () => void
}) {
  const [drag, setDrag] = useState<Box | null>(null)
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX,
      y0 = e.clientY
    const box = (p: PointerEvent): Box => ({
      x: Math.min(x0, p.clientX),
      y: Math.min(y0, p.clientY),
      w: Math.abs(p.clientX - x0),
      h: Math.abs(p.clientY - y0),
    })
    setDrag({ x: x0, y: y0, w: 0, h: 0 })
    const move = (m: PointerEvent) => setDrag(box(m))
    const up = (u: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      const b = box(u)
      if (u.type === 'pointerup' && b.w > 12 && b.h > 12) onDone(toScene(api, b))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div className="nt-mark" onPointerDown={down}>
      <div className="nt-mark-hint">
        {hint}{' '}
        <button type="button" onPointerDown={e => e.stopPropagation()} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {drag && <div className="nt-box" style={boxStyle(drag)} />}
    </div>
  )
}
