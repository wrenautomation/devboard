// Local patch: Scratch. Drag a box to make a frame named "Scratch (Claude ignores)".
// The server hides what is inside any frame named "Scratch…" from every agent (see scratchHidden in server.ts).
// A frame made with Excalidraw's own frame tool and renamed "Scratch…" works the same way.

import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useState } from 'react'
import { BoxDraw } from './BoxDraw'
import { edited } from './edits'
import { EyeOff } from './icons'
import type { Box } from './view'

export const SCRATCH_NAME = 'Scratch (Claude ignores)'

// Same rule as scratchHidden in server.ts: scratch frames and what sits inside them. For thumbnails.
type Placed = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  name?: string | null
  frameId?: string | null
  containerId?: string | null
}
export function withoutScratch<T extends Placed>(all: readonly T[]): T[] {
  const frames = all.filter(e => e.type === 'frame' && /^scratch/i.test(String(e.name ?? '')))
  if (!frames.length) return [...all]
  const ids = new Set(frames.map(f => f.id))
  const inside = (e: T) => {
    const cx = e.x + e.width / 2,
      cy = e.y + e.height / 2
    return frames.some(f => cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height)
  }
  const hidden = new Set(
    all.filter(e => ids.has(e.id) || (e.frameId && ids.has(e.frameId)) || inside(e)).map(e => e.id),
  )
  return all.filter(e => !hidden.has(e.id) && !(e.containerId && hidden.has(e.containerId)))
}

export function Scratch({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [drawing, setDrawing] = useState(false)

  const make = (b: Box) => {
    setDrawing(false)
    if (!api) return
    // restoreElements fills in every field Excalidraw needs from this skeleton.
    const skeleton = {
      type: 'frame',
      id: `scratch-${Date.now().toString(36)}`,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      name: SCRATCH_NAME,
      strokeColor: '#bbb',
      backgroundColor: 'transparent',
    } as unknown as ExcalidrawElement
    const [frame] = restoreElements([skeleton], null)
    if (!frame) return
    // Shapes already in the box move into the frame (centre inside, same rule as the server).
    const inside = (e: ExcalidrawElement) => {
      const cx = e.x + e.width / 2,
        cy = e.y + e.height / 2
      return !e.frameId && e.type !== 'frame' && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h
    }
    const elements = api
      .getSceneElementsIncludingDeleted()
      .map(e => (!e.isDeleted && inside(e) ? edited(e, { frameId: frame.id }) : e))
    api.updateScene({
      elements: [...elements, frame],
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    void flush() // a button edit has no canvas touch, so autosave would wait; save now
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setDrawing(true)}
        title="Drag a box. Claude never sees what is inside it."
        aria-label="Scratch"
      >
        <EyeOff size={17} />
        <span className="hb-word">Scratch</span>
      </button>
      {drawing && api && (
        <BoxDraw
          api={api}
          hint="Drag a box for scratch work. Claude never sees inside it"
          onDone={make}
          onCancel={() => setDrawing(false)}
        />
      )}
    </>
  )
}
