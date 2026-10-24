// Local patch: an X at the top-right of the selection deletes it, as one undo step.
// Hidden while a shape is drawn, moved, resized, rotated or its text is edited.

import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useState } from 'react'
import { X } from './icons'
import { type Box, toScreen } from './view'

export function SelectionDelete({ api, flush }: { api: ExcalidrawImperativeAPI | null; flush: () => Promise<void> }) {
  const [at, setAt] = useState<Box | null>(null)

  useEffect(() => {
    if (!api) return
    const read = () => {
      const s = api.getAppState()
      const busy =
        s.newElement ||
        s.editingTextElement ||
        s.selectedElementsAreBeingDragged ||
        s.isResizing ||
        s.isRotating ||
        s.viewModeEnabled
      const sel = s.selectedElementIds
      const els = busy ? [] : api.getSceneElements().filter(e => sel[e.id])
      if (!els.length) {
        setAt(null)
        return
      }
      const [x1, y1, x2, y2] = getCommonBounds(els)
      setAt(toScreen(api, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }))
    }
    read()
    return api.onChange(read)
  }, [api])

  const remove = () => {
    if (!api) return
    const sel = api.getAppState().selectedElementIds
    const gone = new Set(
      api
        .getSceneElements()
        .filter(e => sel[e.id])
        .map(e => e.id),
    )
    const has = (id: string | null | undefined) => !!id && gone.has(id)
    // Bound labels and a frame's children go with their shape.
    const goes = (e: ExcalidrawElement) => has(e.id) || has('containerId' in e ? e.containerId : null) || has(e.frameId)
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map(e => (!e.isDeleted && goes(e) ? newElementWith(e, { isDeleted: true }) : e)),
      appState: { selectedElementIds: {}, selectedGroupIds: {} },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    void flush() // a button edit has no canvas touch, so autosave would wait; save now
  }

  if (!at) return null
  // Above the top-right resize handle, so the two never overlap.
  return (
    <button
      type="button"
      className="sel-delete"
      style={{ left: Math.min(at.x + at.w + 6, window.innerWidth - 52), top: Math.max(at.y - 44, 64) }}
      onClick={remove}
      onPointerDown={e => e.stopPropagation()}
      aria-label="Delete selected"
      title="Delete"
    >
      <X size={18} />
    </button>
  )
}
