import type { Request, Response } from 'express'
import { elements, type ServerElement } from '../types.js'
import { fail } from './reply.js'

// Local patch: scratch areas. A frame named "Scratch…" holds rough work that must never reach a model.
// Agents (CLI, MCP, curl) never see what is inside one; only the canvas tab (header x-devboard-tab: 1) does.
// The frame itself stays visible, so an agent knows not to draw there, but an agent cannot move or delete it.
export const SCRATCH_NAME = /^scratch/i
export const isTab = (req: Request) => req.get('x-devboard-tab') === '1'
export const isScratchFrame = (e: ServerElement | undefined) =>
  !!e && e.type === 'frame' && SCRATCH_NAME.test(String(e.name ?? ''))
export function scratchHidden(): Set<string> {
  const all = Array.from(elements.values())
  const frames = all.filter(isScratchFrame)
  const hidden = new Set<string>()
  if (!frames.length) return hidden
  const frameIds = new Set(frames.map(f => f.id))
  // Inside = assigned to the frame, or centre inside it (Excalidraw assigns only shapes drawn fully inside).
  const inside = (e: ServerElement) => {
    const cx = e.x + (e.width ?? 0) / 2,
      cy = e.y + (e.height ?? 0) / 2
    return frames.some(f => cx >= f.x && cx <= f.x + (f.width ?? 0) && cy >= f.y && cy <= f.y + (f.height ?? 0))
  }
  for (const e of all) {
    if (!frameIds.has(e.id) && ((e.frameId && frameIds.has(e.frameId)) || inside(e))) hidden.add(e.id)
  }
  for (const e of all) if (e.containerId && hidden.has(e.containerId)) hidden.add(e.id)
  return hidden
}
// What an agent's clear, replace or overwrite keeps: scratch frames and their contents. A tab keeps nothing.
export function scratchKept(req: Request): ServerElement[] {
  if (isTab(req)) return []
  const hidden = scratchHidden()
  return Array.from(elements.values()).filter(e => hidden.has(e.id) || isScratchFrame(e))
}
export function visibleTo<T extends { id: string }>(req: Request, list: T[]): T[] {
  if (isTab(req)) return list
  const hidden = scratchHidden()
  return hidden.size ? list.filter(e => !hidden.has(e.id)) : list
}
// An agent may not read, change or delete scratch work, nor move or delete a scratch frame.
export function scratchBlock(req: Request, res: Response, id: string, write: boolean): boolean {
  if (isTab(req)) return false
  if (scratchHidden().has(id)) {
    fail(res, 404, `Element with ID ${id} not found`)
    return true
  }
  if (write && isScratchFrame(elements.get(id))) {
    fail(res, 403, 'This is a scratch area. Only William changes it.')
    return true
  }
  return false
}
