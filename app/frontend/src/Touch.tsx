// Local patch: Pencil and finger do different jobs, so the tool rarely needs a tap on the toolbar.
// The Pencil uses the chosen tool (the pen). One finger pans; a finger tap selects the top shape under it,
// and a finger drag that starts on the selection moves it. Two fingers pinch. A two-finger tap undoes,
// a three-finger tap redoes. Each switch is to Excalidraw's own tool (hand or selection) for one gesture,
// set in a capture listener before Excalidraw reads the pointerdown; the pen tool comes back after it.

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { type Point, scenePoint } from './view'

type ToolType = ReturnType<ExcalidrawImperativeAPI['getAppState']>['activeTool']['type']
const TAP_MS = 300,
  TAP_PX = 10,
  SLOP = 12 // screen px of grace around the selection, for its handles

// Scene bounds of an element; a line, arrow or stroke spans its points.
function bounds(el: ExcalidrawElement) {
  if ('points' in el && el.points.length) {
    const xs = el.points.map(p => p[0]),
      ys = el.points.map(p => p[1])
    return { x1: el.x + Math.min(...xs), y1: el.y + Math.min(...ys), x2: el.x + Math.max(...xs), y2: el.y + Math.max(...ys) }
  }
  return { x1: el.x, y1: el.y, x2: el.x + el.width, y2: el.y + el.height }
}

const inside = (el: ExcalidrawElement, p: Point, pad: number) => {
  const b = bounds(el)
  return p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad
}

// The top shape under a point. A frame is a backdrop: a tap inside it picks what it holds.
function topAt(api: ExcalidrawImperativeAPI, p: Point, pad: number): ExcalidrawElement | undefined {
  const all = api.getSceneElements()
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]
    if (el && el.type !== 'frame' && el.type !== 'magicframe' && !el.locked && inside(el, p, pad)) return el
  }
  return undefined
}

const onSelection = (api: ExcalidrawImperativeAPI, p: Point, pad: number) => {
  const ids = api.getAppState().selectedElementIds
  return api.getSceneElements().some(el => ids[el.id] && inside(el, p, pad))
}

const press = (label: string) =>
  document.querySelector<HTMLButtonElement>(`.excalidraw button[aria-label="${label}"]`)?.click()

export function Touch({ api }: { api: ExcalidrawImperativeAPI | null }) {
  useEffect(() => {
    if (!api) return
    let back: ToolType | null = null // the user's tool while a gesture borrows hand or selection
    let ours: ToolType | null = null // the tool this patch set; any other means the user chose one
    const fingers = new Map<number, { x: number; y: number; t: number }>()
    let most = 0,
      moved = false,
      began = 0

    const tool = () => api.getAppState().activeTool.type
    // Synchronous, so Excalidraw's own pointerdown, next on the same event, reads the new tool.
    const set = (type: ToolType) =>
      flushSync(() => api.setActiveTool({ type } as Parameters<ExcalidrawImperativeAPI['setActiveTool']>[0]))
    const use = (type: ToolType) => {
      if (tool() === type) return
      if (back === null || tool() !== ours) back = tool()
      ours = type
      set(type)
    }
    const restore = () => {
      if (back !== null && tool() === ours) {
        set(back)
      }
      back = ours = null
    }
    const onCanvas = (e: PointerEvent) =>
      e.target instanceof HTMLCanvasElement && e.target.classList.contains('interactive')
    const pad = () => SLOP / api.getAppState().zoom.value

    const down = (e: PointerEvent) => {
      if (!onCanvas(e)) return
      if (back !== null && tool() !== ours) back = ours = null // the user picked a tool on the bar
      const p = scenePoint(api, { x: e.clientX, y: e.clientY })
      if (e.pointerType === 'pen') {
        // The Pencil draws, unless it lands on the selection a finger made: then it moves it.
        if (ours === 'selection' && onSelection(api, p, pad())) return
        restore()
        return
      }
      if (e.pointerType !== 'touch') return
      if (!fingers.size) {
        most = 0
        moved = false
        began = e.timeStamp
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp })
      most = Math.max(most, fingers.size)
      if (fingers.size > 1) return // Excalidraw pinches with two fingers in any tool
      if (back === null && tool() === 'selection') return // the user chose selection: Excalidraw's own touch
      use(onSelection(api, p, pad()) ? 'selection' : 'hand')
    }

    const move = (e: PointerEvent) => {
      const f = fingers.get(e.pointerId)
      if (f && Math.hypot(e.clientX - f.x, e.clientY - f.y) > TAP_PX) moved = true
    }

    const up = (e: PointerEvent) => {
      if (!fingers.delete(e.pointerId) || fingers.size) return
      const tap = !moved && e.timeStamp - began < TAP_MS
      if (most > 1) {
        // A pinch or a multi-finger tap: the first finger borrowed the hand, give the tool back.
        if (ours === 'hand') restore()
        if (tap && most === 2) press('Undo')
        if (tap && most === 3) press('Redo')
        return
      }
      if (ours === null) return
      if (!tap) {
        if (ours === 'hand') restore()
        return
      }
      // A tap: select the top shape under the finger, or clear the selection.
      const hit = topAt(api, scenePoint(api, { x: e.clientX, y: e.clientY }), 0)
      if (!hit) {
        api.updateScene({ appState: { selectedElementIds: {} } })
        restore()
        return
      }
      use('selection')
      // After Excalidraw's own pointerup, which may clear the selection of the hand tool.
      setTimeout(() => api.updateScene({ appState: { selectedElementIds: { [hit.id]: true } } }))
    }

    const cancel = (e: PointerEvent) => {
      fingers.delete(e.pointerId)
      if (!fingers.size && ours === 'hand') restore()
    }

    const opts = { capture: true }
    window.addEventListener('pointerdown', down, opts)
    window.addEventListener('pointermove', move, opts)
    window.addEventListener('pointerup', up, opts)
    window.addEventListener('pointercancel', cancel, opts)
    return () => {
      window.removeEventListener('pointerdown', down, opts)
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('pointerup', up, opts)
      window.removeEventListener('pointercancel', cancel, opts)
    }
  }, [api])
  return null
}
