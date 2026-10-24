import type { Response } from 'express'
import {
  CanvasFileImmutabilityError,
  CanvasFileReferenceError,
  CanvasPersistenceError,
} from '../core/canvas-persistence.js'

// Every refused request answers the same shape.
export function fail(res: Response, status: number, error: string): Response {
  return res.status(status).json({ success: false, error })
}

export function mutationErrorStatus(error: unknown, fallback: number): number {
  if (error instanceof CanvasPersistenceError) return 500
  if (error instanceof CanvasFileImmutabilityError || error instanceof CanvasFileReferenceError) return 409
  return fallback
}
