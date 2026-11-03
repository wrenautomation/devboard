// Local patch: thumbnail of the open board for the Projects view; scratch areas are left out.
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { type RefObject, useEffect, useRef } from 'react'
import { postBinary, TAB } from './api'
import { withoutScratch } from './Scratch'

export type ThumbShot = {
  project: string
  elements: readonly ExcalidrawElement[]
  files: BinaryFiles
  appState: AppState
}

async function postThumb({ project, elements: all, files, appState }: ThumbShot) {
  const elements = withoutScratch(all)
  if (!elements.length) return
  const blob = await exportToBlob({
    elements,
    files,
    maxWidthOrHeight: 480,
    mimeType: 'image/png',
    appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
  })
  await postBinary('/api/projects/thumb', blob, { ...TAB, 'x-canvas-project': project })
}

// sceneProject: the board the scene on screen belongs to (App's sceneProjectRef)
export function useThumbs(api: RefObject<ExcalidrawImperativeAPI | null>, sceneProject: RefObject<string | null>) {
  // last thumbnailed state per board: an unchanged board is not rendered again
  const keys = useRef(new Map<string, string>())
  const at = useRef(0)
  // The thumbnail renders the whole board on the main thread (~0.2s on 400 strokes): wait until the pen is up.
  const penDown = useRef(false)
  useEffect(() => {
    const up = () => {
      penDown.current = false
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const shot = (): ThumbShot | null => {
    const a = api.current,
      project = sceneProject.current
    if (!a || !project) return null
    return { project, elements: a.getSceneElements(), files: a.getFiles(), appState: a.getAppState() }
  }
  const save = async (s = shot()) => {
    if (!s) return
    const key = `${s.elements.length}:${s.elements.reduce((n, el) => n + el.version, 0)}`
    if (keys.current.get(s.project) === key) return
    keys.current.set(s.project, key)
    await postThumb(s).catch(() => keys.current.delete(s.project))
  }
  const soon = (s?: ThumbShot | null): void => {
    setTimeout(() => (penDown.current ? soon(s) : void save(s ?? shot())), 1500)
  }
  // after a confirmed push: a fresh thumbnail at most once a minute while the board changes
  const changed = (): void => {
    if (Date.now() - at.current < 60_000) return
    at.current = Date.now()
    soon()
  }
  return { penDown, shot, save, soon, changed }
}
