// Local patch: drag a box over the canvas. Used by Mark area (Send to Claude) and Scratch.
import React, { useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export type Box = { x: number; y: number; w: number; h: number }

export const boxStyle = (b: Box) => ({ left: b.x, top: b.y, width: b.w, height: b.h })

// Scene coords <-> screen coords, from the canvas's current scroll and zoom.
export function toScreen(api: ExcalidrawImperativeAPI, b: Box): Box {
  const s = api.getAppState(), z = s.zoom.value
  return { x: (b.x + s.scrollX) * z + s.offsetLeft, y: (b.y + s.scrollY) * z + s.offsetTop, w: b.w * z, h: b.h * z }
}
export function toScene(api: ExcalidrawImperativeAPI, b: Box): Box {
  const s = api.getAppState(), z = s.zoom.value
  return { x: (b.x - s.offsetLeft) / z - s.scrollX, y: (b.y - s.offsetTop) / z - s.scrollY, w: b.w / z, h: b.h / z }
}

// Full-screen layer. onDone gets the box in scene coords; a box under 12px is ignored.
export function BoxDraw({ api, hint, onDone, onCancel }: {
  api: ExcalidrawImperativeAPI; hint: string; onDone: (scene: Box) => void; onCancel: () => void
}) {
  const [drag, setDrag] = useState<Box | null>(null)
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX, y0 = e.clientY
    const box = (p: PointerEvent): Box => ({ x: Math.min(x0, p.clientX), y: Math.min(y0, p.clientY), w: Math.abs(p.clientX - x0), h: Math.abs(p.clientY - y0) })
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
      <div className="nt-mark-hint">{hint} <button onPointerDown={e => e.stopPropagation()} onClick={onCancel}>Cancel</button></div>
      {drag && <div className="nt-box" style={boxStyle(drag)} />}
    </div>
  )
}
