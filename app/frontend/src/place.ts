// Local patch: puts library shapes on the canvas for the Icons panel and the Library sidebar.
// Size follows the zoom: a small item shows at least MIN_PX on screen; a big one keeps its own size on screen.
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export type Drop = { x: number; y: number }

const MIN_PX = 120

const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4)
// Fresh ids for a set of old ones: the same old id maps to the same new one.
const remap = () => {
  const made = new Map<string, string>()
  return (old: string): string => {
    const next = made.get(old) ?? newId()
    made.set(old, next)
    return next
  }
}

// A pack shape read field by field: points, labels and bindings sit on some element kinds only.
type PackShape = ExcalidrawElement & {
  points?: readonly (readonly [number, number])[]
  fontSize?: number
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}

// Copies shapes with fresh ids (groups, text containers and arrow bindings remapped), scaled by k about their centre, centred at cx,cy.
function cloneAt(shapes: readonly ExcalidrawElement[], cx: number, cy: number, k: number): ExcalidrawElement[] {
  const elements = shapes as readonly PackShape[]
  const id = remap(),
    gid = remap()
  const x0 = Math.min(...elements.map(e => e.x)),
    y0 = Math.min(...elements.map(e => e.y))
  const x1 = Math.max(...elements.map(e => e.x + (e.width || 0))),
    y1 = Math.max(...elements.map(e => e.y + (e.height || 0)))
  const mx = (x0 + x1) / 2,
    my = (y0 + y1) / 2
  const known = new Set(elements.map(e => e.id))
  const keep = (old?: string | null) => (old && known.has(old) ? id(old) : null)
  return elements.map(e => ({
    ...e,
    id: id(e.id),
    x: cx + (e.x - mx) * k,
    y: cy + (e.y - my) * k,
    width: (e.width || 0) * k,
    height: (e.height || 0) * k,
    ...(e.points && { points: e.points.map(([px, py]) => [px * k, py * k]) }),
    ...(e.fontSize && { fontSize: e.fontSize * k }),
    groupIds: (e.groupIds || []).map(gid),
    frameId: null,
    containerId: keep(e.containerId),
    boundElements: e.boundElements?.filter(b => known.has(b.id)).map(b => ({ ...b, id: id(b.id) })) ?? null,
    startBinding:
      e.startBinding && known.has(e.startBinding.elementId)
        ? { ...e.startBinding, elementId: id(e.startBinding.elementId) }
        : null,
    endBinding:
      e.endBinding && known.has(e.endBinding.elementId)
        ? { ...e.endBinding, elementId: id(e.endBinding.elementId) }
        : null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
    isDeleted: false,
    locked: false,
  })) as unknown as ExcalidrawElement[]
}

// at = the drop point on screen; none = the middle of the view. The new shapes come in selected, as one undo step.
export function placeOnCanvas(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], at?: Drop): void {
  const live = elements.filter(e => !e.isDeleted)
  if (!live.length) return
  const s = api.getAppState()
  const zoom = s.zoom.value
  const sx = at ? at.x - s.offsetLeft : s.width / 2,
    sy = at ? at.y - s.offsetTop : s.height / 2
  const cx = sx / zoom - s.scrollX,
    cy = sy / zoom - s.scrollY
  const side = Math.max(...live.map(e => e.x + (e.width || 0))) - Math.min(...live.map(e => e.x))
  const tall = Math.max(...live.map(e => e.y + (e.height || 0))) - Math.min(...live.map(e => e.y))
  const big = Math.max(side, tall, 1)
  const k = Math.max(big, MIN_PX) / big / zoom
  const added = restoreElements(cloneAt(live, cx, cy, k), null)
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...added],
    appState: { selectedElementIds: Object.fromEntries(added.map(e => [e.id, true] as const)) },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}
