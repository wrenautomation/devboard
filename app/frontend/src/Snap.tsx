// Local patch: hold the pen still at the end of a stroke and it snaps to the shape it meant (fitShape.ts), as in GoodNotes.
// The stroke stays a freedraw element: same color, width and ink, only its points change, at one steady pressure.
// At the hold this ends Excalidraw's stroke with a pointerup of its own, then swaps the points. The pen is still down:
// its moves and its lift are ours from then on, so a line's far end follows it until the lift.

import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect } from 'react'
import { edited } from './edits'
import { type Fit, fit, type P, resample, straight } from './fitShape'
import { scenePoint } from './view'

const HOLD_MS = 500,
  HOLD_PX = 5, // screen px the Pencil may drift and still count as held
  STEP_PX = 3, // screen px between the snapped stroke's points
  MIN_PX = 24 // a shorter stroke is a dot or a tick: never snapped

type Pt = readonly [number, number]

// Points in scene coords → the element's own: x, y at the top left, points from there.
function placed(el: ExcalidrawFreeDrawElement, ps: P[], pressure: number | null): ExcalidrawFreeDrawElement {
  const x = Math.min(...ps.map(p => p.x)),
    y = Math.min(...ps.map(p => p.y))
  const points = ps.map(p => [p.x - x, p.y - y] as Pt)
  return edited(el, {
    x,
    y,
    width: Math.max(...ps.map(p => p.x)) - x,
    height: Math.max(...ps.map(p => p.y)) - y,
    points: points as unknown as ExcalidrawFreeDrawElement['points'],
    pressures: pressure === null ? [] : points.map(() => pressure),
    lastCommittedPoint: points[points.length - 1] as unknown as ExcalidrawFreeDrawElement['lastCommittedPoint'],
  })
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s[Math.floor(s.length / 2)] as number) : 0.5
}

export function Snap({ api }: { api: ExcalidrawImperativeAPI | null }) {
  useEffect(() => {
    if (!api) return
    // The stroke being drawn: its pointer, where the pen last settled, and the hold timer.
    let stroke: { id: number; at: { x: number; y: number }; timer: number } | null = null
    // After a snap, while the pen is still down.
    let held: { pointer: number; id: string; fit: Fit; pressure: number | null } | null = null
    let ours = false // the pointerup this patch sends to Excalidraw

    const onCanvas = (e: PointerEvent) =>
      e.target instanceof HTMLCanvasElement && e.target.classList.contains('interactive')
    const step = () => STEP_PX / api.getAppState().zoom.value
    const replace = (el: ExcalidrawFreeDrawElement, captureUpdate: 'EVENTUALLY' | 'IMMEDIATELY') =>
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map(e => (e.id === el.id ? el : e)),
        captureUpdate: CaptureUpdateAction[captureUpdate],
      })
    const element = (id: string) =>
      api.getSceneElements().find(e => e.id === id && e.type === 'freedraw') as ExcalidrawFreeDrawElement | undefined

    const settle = (e: PointerEvent) => {
      if (!stroke) return
      window.clearTimeout(stroke.timer)
      stroke.at = { x: e.clientX, y: e.clientY }
      const id = e.pointerId
      stroke.timer = window.setTimeout(() => hold(id, e), HOLD_MS)
    }

    const hold = (pointer: number, e: PointerEvent) => {
      const el = api.getAppState().newElement
      if (!stroke || stroke.id !== pointer || el?.type !== 'freedraw') return
      const z = api.getAppState().zoom.value
      const got = fit(
        el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py })),
        step(),
        MIN_PX / z,
      )
      if (!got) return
      const pressure = el.simulatePressure ? null : median(el.pressures)
      stroke = null
      // Excalidraw ends the stroke and keeps it, as on a lift.
      ours = true
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: pointer,
          pointerType: e.pointerType,
          isPrimary: true,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
        }),
      )
      ours = false
      held = { pointer, id: el.id, fit: got, pressure }
      // A task later, after Excalidraw's own update: the stroke and its snap are one undo step. Sooner, the first undo did nothing.
      window.setTimeout(() => {
        const done = element(el.id)
        if (done) replace(placed(done, got.points, pressure), 'EVENTUALLY')
      })
    }

    // A line's far end follows the pen; other shapes stay as snapped.
    const drag = (e: PointerEvent, last: boolean) => {
      if (!held) return
      const el = element(held.id)
      if (!el) return
      let ps = held.fit.points
      if (held.fit.kind === 'line') {
        const a = ps[0] as P
        ps = resample(straight(a, scenePoint(api, { x: e.clientX, y: e.clientY })), step())
      }
      replace(placed(el, ps, held.pressure), last ? 'IMMEDIATELY' : 'EVENTUALLY')
    }

    const down = (e: PointerEvent) => {
      if (!onCanvas(e) || e.pointerType === 'touch' || e.button !== 0) return
      if (api.getAppState().activeTool.type !== 'freedraw') return
      stroke = { id: e.pointerId, at: { x: e.clientX, y: e.clientY }, timer: 0 }
      settle(e)
    }

    const move = (e: PointerEvent) => {
      if (held?.pointer === e.pointerId) {
        e.stopImmediatePropagation()
        if (held.fit.kind === 'line') drag(e, false)
        return
      }
      if (stroke?.id === e.pointerId && Math.hypot(e.clientX - stroke.at.x, e.clientY - stroke.at.y) > HOLD_PX)
        settle(e)
    }

    const up = (e: PointerEvent) => {
      if (ours) return
      if (held?.pointer === e.pointerId) {
        e.stopImmediatePropagation()
        drag(e, true)
        held = null
        return
      }
      if (stroke?.id === e.pointerId) {
        window.clearTimeout(stroke.timer)
        stroke = null
      }
    }

    const opts = { capture: true }
    window.addEventListener('pointerdown', down, opts)
    window.addEventListener('pointermove', move, opts)
    window.addEventListener('pointerup', up, opts)
    window.addEventListener('pointercancel', up, opts)
    return () => {
      if (stroke) window.clearTimeout(stroke.timer)
      window.removeEventListener('pointerdown', down, opts)
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('pointerup', up, opts)
      window.removeEventListener('pointercancel', up, opts)
    }
  }, [api])
  return null
}
