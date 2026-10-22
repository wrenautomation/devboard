// Local patch: Scratch. Drag a box to make a frame named "Scratch (Claude ignores)".
// The server hides what is inside any frame named "Scratch…" from every agent (see scratchHidden in server.ts).
// A frame made with Excalidraw's own frame tool and renamed "Scratch…" works the same way.
import React, { useState } from 'react'
import { restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { BoxDraw, type Box } from './BoxDraw'

export const SCRATCH_NAME = 'Scratch (Claude ignores)'

export function Scratch({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const [drawing, setDrawing] = useState(false)

  const make = (b: Box) => {
    setDrawing(false)
    if (!api) return
    const [frame] = restoreElements([{
      type: 'frame', id: `scratch-${Date.now().toString(36)}`, x: b.x, y: b.y, width: b.w, height: b.h, name: SCRATCH_NAME,
      strokeColor: '#bbb', backgroundColor: 'transparent',
    } as any], null)
    // Shapes already in the box move into the frame (centre inside, same rule as the server).
    const inside = (e: any) => {
      const cx = e.x + e.width / 2, cy = e.y + e.height / 2
      return !e.frameId && e.type !== 'frame' && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h
    }
    const elements = api.getSceneElementsIncludingDeleted().map(e => (!e.isDeleted && inside(e)
      ? { ...e, frameId: frame!.id, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
      : e))
    api.updateScene({
      elements: [...elements, frame!] as any,
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }

  return (
    <>
      <button className="btn-secondary" onClick={() => setDrawing(true)} title="Drag a box. Claude never sees what is inside it.">Scratch</button>
      {drawing && api && <BoxDraw api={api} hint="Drag a box for scratch work. Claude never sees inside it" onDone={make} onCancel={() => setDrawing(false)} />}
    </>
  )
}
