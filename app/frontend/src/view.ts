// Scene coordinates <-> screen coordinates, from the canvas's current scroll and zoom.
// Screen points are page coordinates (clientX/clientY).
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export type Point = { x: number; y: number }
export type Box = { x: number; y: number; w: number; h: number }

export const boxStyle = (b: Box) => ({ left: b.x, top: b.y, width: b.w, height: b.h })

export function toScreen(api: ExcalidrawImperativeAPI, b: Box): Box {
  const s = api.getAppState(),
    z = s.zoom.value
  return { x: (b.x + s.scrollX) * z + s.offsetLeft, y: (b.y + s.scrollY) * z + s.offsetTop, w: b.w * z, h: b.h * z }
}

export function toScene(api: ExcalidrawImperativeAPI, b: Box): Box {
  const s = api.getAppState(),
    z = s.zoom.value
  return { x: (b.x - s.offsetLeft) / z - s.scrollX, y: (b.y - s.offsetTop) / z - s.scrollY, w: b.w / z, h: b.h / z }
}

export function scenePoint(api: ExcalidrawImperativeAPI, p: Point): Point {
  const { x, y } = toScene(api, { ...p, w: 0, h: 0 })
  return { x, y }
}

// The middle of the visible canvas, in scene coordinates.
export function viewCentre(api: ExcalidrawImperativeAPI): Point {
  const s = api.getAppState(),
    z = s.zoom.value
  return { x: s.width / 2 / z - s.scrollX, y: s.height / 2 / z - s.scrollY }
}
