import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { ServerElement } from '../types.js'
import { elements } from '../types.js'

// Excalidraw stacks elements by `index`, with each frame above its children:
// it inserts a new child (a pen stroke) directly below its frame. Agents send
// no index, often the frame first. A stroke then landed under the frame's image.
// Fill each missing key in place, between its valid neighbours, then move each
// newly keyed child below its frame. Only keyless elements change, so the
// broadcast of the write carries every new key.
const valid = (key: unknown): key is string => {
  if (typeof key !== 'string') return false
  try {
    generateKeyBetween(key, null)
    return true
  } catch {
    return false
  }
}

export function fillMissingIndices(): void {
  const list = [...elements.values()]
  const keys = list.map(el => (valid(el.index) ? el.index : null))
  const keyed = list.filter((_, i) => !keys[i])
  let lower: string | null = null
  for (let i = 0; i < list.length; ) {
    const key = keys[i]
    if (key) {
      if (lower === null || key > lower) lower = key
      i++
      continue
    }
    let end = i
    while (end < list.length && !keys[end]) end++
    const next = keys[end] ?? null
    const fresh = generateNKeysBetween(lower, next !== null && (lower === null || next > lower) ? next : null, end - i)
    fresh.forEach((k, j) => {
      const el = list[i + j]
      if (el) el.index = k
    })
    lower = fresh.at(-1) ?? lower
    i = end
  }
  placeBelowFrames(keyed)
}

function placeBelowFrames(keyed: ServerElement[]): void {
  const above = new Map<string, ServerElement[]>()
  for (const el of keyed) {
    const frame = el.frameId ? elements.get(el.frameId as string) : undefined
    if (!frame?.index || !el.index || el.index < frame.index) continue
    above.set(frame.id, [...(above.get(frame.id) ?? []), el])
  }
  for (const [frameId, children] of above) {
    const top = elements.get(frameId)?.index as string
    const moving = new Set(children)
    let below: string | null = null
    for (const el of elements.values()) {
      if (moving.has(el) || !el.index || el.index >= top) continue
      if (below === null || el.index > below) below = el.index
    }
    generateNKeysBetween(below, top, children.length).forEach((k, j) => {
      const el = children[j]
      if (el) el.index = k
    })
  }
}
