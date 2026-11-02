import type { ServerElement } from '../types.js'

// Local patch (designs/2026-11-02-board-pins.md): pen points rounded to 0.01 px.
// 16-digit floats were ~half of a handwriting board's bytes; no visible change.
const round = (n: number) => Math.round(n * 100) / 100
export function compact(el: ServerElement): ServerElement {
  const e = el as ServerElement & { points?: number[][]; lastCommittedPoint?: number[] | null }
  if (!Array.isArray(e.points) || e.points.length < 3) return el
  return {
    ...e,
    points: e.points.map(p => p.map(round)),
    ...(Array.isArray(e.lastCommittedPoint) ? { lastCommittedPoint: e.lastCommittedPoint.map(round) } : {}),
  } as unknown as ServerElement
}
