// Edits our own buttons make outside Excalidraw's tools. They bump the version the way Excalidraw does, so
// sync (the higher version wins) and the Mac's tie-break (the lower nonce) treat them as edits.
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

export const nonce = () => Math.floor(Math.random() * 2 ** 31)

export const edited = <T extends ExcalidrawElement>(e: T, patch: Partial<T>): T => ({
  ...e,
  ...patch,
  version: e.version + 1,
  versionNonce: nonce(),
  updated: Date.now(),
})
