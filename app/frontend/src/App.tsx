import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  exportToBlob,
  exportToSvg,
  elementsOverlappingBBox,
  useHandleLibrary,
  newElementWith
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type {
  LibraryPersistedData,
  LibraryPersistenceAdapter
} from '@excalidraw/excalidraw/data/library'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import { cleanElementForExcalidraw, prepareServerScene, assertScenePreserved } from './utils/scene'
import { preloadCanvasFonts } from './utils/fonts'
import { IconPanel } from './IconPanel'
import { SelectionDelete } from './SelectionDelete'
import { Notify } from './Notify'
import { Scratch, withoutScratch } from './Scratch'
import { Projects } from './Projects'
import { Eraser, Shapes } from 'lucide-react'
import { Voice } from './Voice'
import { StrokeWidth } from './StrokeWidth'
import type { ServerElement } from './utils/scene'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

// Local patch: marks the canvas tab, so the server shows it scratch areas (agents get them hidden).
const TAB = { 'x-devboard-tab': '1' }

const LIBRARY_STORAGE_KEY = 'excalidraw-canvas-library'

/**
 * Persists the user's library in this browser.
 *
 * The scene is in-memory by design, but the library is not scene data — it is a
 * user asset: shapes they added themselves, or a pack they installed from
 * libraries.excalidraw.com. Without an adapter the library panel resets to empty
 * on every reload, which makes it useless, and `useHandleLibrary` below needs one
 * to accept installs in the first place.
 */
// Local patch: IndexedDB, not localStorage. Safari's 5MB localStorage quota can't hold a big icon pack.
// Reads the old localStorage copy once, if there is one.
const libraryDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const req = indexedDB.open('excalidraw-canvas', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('kv')
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})
const libraryAdapter: LibraryPersistenceAdapter = {
  load: async () => {
    try {
      const db = await libraryDb()
      const items = await new Promise<any>((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(LIBRARY_STORAGE_KEY)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      if (items) return { libraryItems: items }
      const raw = window.localStorage?.getItem(LIBRARY_STORAGE_KEY)
      if (raw) return { libraryItems: JSON.parse(raw) }
      // First visit: start with the canvas's own pack (brand logos, system design, stickies).
      const pack = await fetch('/lib/wren.excalidrawlib').then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (!pack?.libraryItems) return null
      await libraryAdapter.save({ libraryItems: pack.libraryItems })
      return { libraryItems: pack.libraryItems }
    } catch (error) {
      console.warn('Failed to read library:', error)
      return null
    }
  },
  save: async (data: LibraryPersistedData) => {
    try {
      const db = await libraryDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(data.libraryItems, LIBRARY_STORAGE_KEY)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      window.localStorage?.removeItem(LIBRARY_STORAGE_KEY)
    } catch (error) {
      console.warn('Failed to save library:', error)
    }
  }
}


// Local patch: drafts. Edits the Mac hasn't confirmed are kept in this browser per project, so a
// dropped connection, a killed tab or a reload never loses them; they go up on the next connect.
type Draft = { elements: unknown[]; version: number; at: number }
// v2: v1 drafts could hold another board's scene (saved under the new name during a switch); they are ignored.
const draftKey = (project: string) => `draft2:${project}`
const idb = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await libraryDb()
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction('kv', mode).objectStore('kv'))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const readDraft = (project: string) => idb<Draft | undefined>('readonly', st => st.get(draftKey(project))).catch(() => undefined)
const writeDraft = (project: string, draft: Draft) => idb('readwrite', st => st.put(draft, draftKey(project))).catch(() => undefined)
const dropDraft = (project: string) => idb('readwrite', st => st.delete(draftKey(project))).catch(() => undefined)
// Changes whenever any element is added, edited or deleted (Excalidraw bumps `version` on each edit).
const sceneVersion = (els: readonly { version: number }[]): number =>
  els.reduce((sum, el) => sum + el.version, 0) * 1000 + els.length

// Local patch: thumbnail of the open board for the Projects view; scratch areas are left out.
async function postThumb(api: ExcalidrawImperativeAPI, project: string) {
  const elements = withoutScratch(api.getSceneElements() as any[]) as any[]
  if (!elements.length) return
  const blob = await exportToBlob({
    elements, files: api.getFiles(), maxWidthOrHeight: 480, mimeType: 'image/png',
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
  })
  await fetch('/api/projects/thumb', { method: 'POST', headers: { 'content-type': 'image/png', 'x-devboard-tab': '1', 'x-canvas-project': project }, body: blob })
}

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ExportImageOptions {
  background?: boolean;
  dark?: boolean;
  scale?: number;
  padding?: number;
  elementIds?: string[];
  frameId?: string;
  area?: { x: number; y: number; w: number; h: number };
  hide?: string[];
  embedScene?: boolean;
}

interface WebSocketMessage {
  type: string;
  format?: 'png' | 'svg';
  background?: boolean;
  options?: ExportImageOptions;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  requestId?: string;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  scrollToElementIds?: string[];
  viewportZoomFactor?: number;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
type SceneLoadStatus = 'loading' | 'ready' | 'failed';
const AUTO_SYNC_DEBOUNCE_MS = 1200;
const SCENE_MUTATIONS = new Set([
  'element_created', 'element_updated', 'element_deleted', 'elements_batch_created'
]);

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])

  // Handles the `#addLibrary=...` callback that libraries.excalidraw.com sends
  // back after "Add to Excalidraw", and loads/saves the library through the
  // adapter above. Without this hook the Browse-libraries button opens the site
  // and correctly points it back here, but nothing receives what it returns —
  // the install silently does nothing.
  // Local patch: also accept libraries served by this canvas (/lib/), next to the public repository.
  useHandleLibrary({
    excalidrawAPI,
    adapter: libraryAdapter,
    validateLibraryUrl: (url) => {
      const u = new URL(url, window.location.href)
      return u.origin === window.location.origin ||
        ['libraries.excalidraw.com', 'raw.githubusercontent.com'].includes(u.hostname)
    },
  })
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const projectRef = useRef<string | null>(null)
  // The board the scene on screen belongs to. projectRef moves at project_opened, before the new scene
  // arrives; drafts, syncs and thumbnails of the old scene must still name the old board.
  const sceneProjectRef = useRef<string | null>(null)
  const thumbAtRef = useRef(0)
  const saveThumb = async () => {
    const api = excalidrawAPIRef.current, project = sceneProjectRef.current
    if (api && project) await postThumb(api, project).catch(() => {})
  }
  // The thumbnail renders the whole board on the main thread (~0.2s on 400 strokes): wait until the pen is up.
  const penDownRef = useRef(false)
  const thumbSoon = (): void => { setTimeout(() => (penDownRef.current ? thumbSoon() : void saveThumb()), 1500) }
  useEffect(() => {
    const up = () => { penDownRef.current = false }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [])
  const syncedVersionRef = useRef<number>(0)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedOnceRef = useRef<boolean>(false)
  const [iconsOpen, setIconsOpen] = useState(false)
  useEffect(() => {
    fetch('/api/projects').then(r => (r.ok ? r.json() : null)).then(d => {
      if (d && !projectRef.current) projectRef.current = d.current
    }).catch(() => {})
    const onProject = (e: Event) => { projectRef.current = (e as CustomEvent<string>).detail }
    window.addEventListener('canvas-project', onProject)
    return () => window.removeEventListener('canvas-project', onProject)
  }, [])
  const websocketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectTriesRef = useRef(0)

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage?.getItem('excalidraw-canvas-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch (error) {
      console.warn('Failed to read theme from localStorage:', error)
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  const userInteractedRef = useRef<boolean>(false)
  // Image files the server already holds, so each sync uploads only new ones
  const serverFileIdsRef = useRef<Set<string>>(new Set())
  const rememberServerFiles = (files: unknown): void => {
    const list = Array.isArray(files) ? files : Object.values((files as Record<string, unknown>) || {})
    for (const file of list as { id?: unknown }[]) {
      if (typeof file?.id === 'string') serverFileIdsRef.current.add(file.id)
    }
  }
  const [sceneLoadStatus, setSceneLoadStatus] = useState<SceneLoadStatus>('loading')
  // A full scene of the open board is on screen. From then on the pen stays live through reconnects and
  // reloads: edits wait as a draft and push when sync opens again (reconcileUnsaved). Only the first
  // scene of a board blocks input.
  const [sceneShown, setSceneShown] = useState(false)
  const sceneLoadStatusRef = useRef<SceneLoadStatus>('loading')
  const sceneGenerationRef = useRef(0)

  const pauseSceneSync = (status: SceneLoadStatus = 'loading'): number => {
    sceneGenerationRef.current += 1
    sceneLoadStatusRef.current = status
    setSceneLoadStatus(status)
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }
    return sceneGenerationRef.current
  }

  const failSceneLoad = (error: unknown, generation = sceneGenerationRef.current): void => {
    if (generation !== sceneGenerationRef.current) return
    console.error('Scene load failed; backend sync is paused:', error)
    pauseSceneSync('failed')
  }

  const canSyncScene = (): boolean =>
    sceneLoadStatusRef.current === 'ready' && websocketRef.current?.readyState === WebSocket.OPEN

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    try {
      api.updateScene(scene)
      syncedVersionRef.current = sceneVersion(api.getSceneElementsIncludingDeleted())
    } finally {
      setTimeout(() => {
        suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
      }, 0)
    }
  }

  const isDirty = (): boolean => {
    const api = excalidrawAPIRef.current
    return !!api && loadedOnceRef.current &&
      sceneVersion(api.getSceneElementsIncludingDeleted()) !== syncedVersionRef.current
  }
  const saveDraftNow = (): void => {
    const api = excalidrawAPIRef.current, project = sceneProjectRef.current
    if (!api || !project || !isDirty()) return
    void writeDraft(project, {
      elements: api.getSceneElementsIncludingDeleted().filter(el => !el.isDeleted),
      version: sceneVersion(api.getSceneElementsIncludingDeleted()), at: Date.now(),
    })
  }
  // A full server scene arrived while this tab holds unsaved edits (reconnect). Same project: the
  // tab wins and pushes. Project changed meanwhile: the edits stay as that project's draft.
  const reconcileUnsaved = async (generation: number): Promise<boolean> => {
    if (!isDirty()) return false
    saveDraftNow()
    const p = await fetch('/api/projects').then(r => (r.ok ? r.json() : null)).catch(() => null)
    if (p && projectRef.current && p.current !== projectRef.current) {
      projectRef.current = p.current
      window.dispatchEvent(new CustomEvent('canvas-project', { detail: p.current }))
      return false
    }
    if (generation !== sceneGenerationRef.current) return true
    sceneLoadStatusRef.current = 'ready'
    setSceneLoadStatus('ready')
    await syncToBackend({ silent: true })
    return true
  }
  // A draft the Mac never got, read once per project before its first scene is shown.
  const draftLoadRef = useRef<Promise<Draft | undefined> | null>(null)
  const loadDraftOnce = (): Promise<Draft | undefined> => {
    if (!draftLoadRef.current) {
      draftLoadRef.current = (async () => {
        if (!projectRef.current) {
          const p = await fetch('/api/projects').then(r => (r.ok ? r.json() : null)).catch(() => null)
          if (p && !projectRef.current) projectRef.current = p.current
        }
        return projectRef.current ? readDraft(projectRef.current) : undefined
      })()
    }
    return draftLoadRef.current
  }
  // Show the server scene, or this project's unsaved draft in its place; the draft stays dirty
  // (and stored) until a save is confirmed.
  const applyLoadedScene = async (
    incoming: readonly Partial<ExcalidrawElement>[], generation: number, files?: Record<string, unknown>
  ): Promise<void> => {
    const draft = await loadDraftOnce()
    if (generation !== sceneGenerationRef.current) return
    // The pen stays live while a scene loads: a stroke drawn during the load wins over the server scene.
    if (await reconcileUnsaved(generation)) return
    if (!draft) { applyServerScene(incoming, generation, files); return }
    draftLoadRef.current = Promise.resolve(undefined)
    applyServerScene(draft.elements as Partial<ExcalidrawElement>[], generation, files)
    syncedVersionRef.current = -1
    console.log(`Restored ${draft.elements.length} unsaved elements for ${projectRef.current}`)
    await syncToBackend({ silent: true })
  }

  // Leaving the tab (app switch, lock screen, close): keep a draft and save now, without the
  // 1.2s debounce. iPad Safari suspends hidden tabs, so a pending timer may never fire.
  const flushOnLeaveRef = useRef<() => void>(() => {})
  flushOnLeaveRef.current = () => {
    if (!isDirty()) return
    saveDraftNow()
    void syncToBackend({ silent: true })
  }
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushOnLeaveRef.current() }
    const onPageHide = () => flushOnLeaveRef.current()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  const applyServerScene = (
    incoming: readonly Partial<ExcalidrawElement>[],
    generation: number,
    files?: Record<string, unknown>,
    opts: { refreshDimensions?: boolean } = {}
  ): void => {
    const api = excalidrawAPIRef.current
    if (!api || generation !== sceneGenerationRef.current) return
    // Prepare everything before replacing the visible scene. restoreElements()
    // can silently filter elements, so both conversion and API readback need checks.
    const prepared = prepareServerScene(incoming, opts)
    const previous = api.getSceneElementsIncludingDeleted()
    try {
      if (files) {
        api.addFiles(Object.values(files) as Parameters<typeof api.addFiles>[0])
        rememberServerFiles(files)
      }
      applySceneUpdateWithoutAutoSync(api, { elements: prepared, captureUpdate: CaptureUpdateAction.NEVER })
      assertScenePreserved(prepared, api.getSceneElements())
    } catch (error) {
      applySceneUpdateWithoutAutoSync(api, { elements: previous, captureUpdate: CaptureUpdateAction.NEVER })
      throw error
    }
    if (sceneProjectRef.current !== projectRef.current) {
      // Another board: its undo steps would replay the old board's shapes here.
      api.history.clear()
      sceneProjectRef.current = projectRef.current
    }
    sceneLoadStatusRef.current = 'ready'
    setSceneLoadStatus('ready')
    setSceneShown(true)
    loadedOnceRef.current = true
  }

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
    }
  }, [])

  // The first scene waits for the Latin fonts (preloadCanvasFonts). Fonts
  // that arrive later, such as CJK subsets or a preload that timed out, find
  // text already measured with a fallback font, which leaves it clipped.
  // Excalidraw itself only redraws then, so re-measure once fonts load.
  useEffect(() => {
    const fontSet = document.fonts
    if (!fontSet?.addEventListener) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const remeasureText = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const api = excalidrawAPIRef.current
        if (!api || sceneLoadStatusRef.current !== 'ready') return
        const current = api.getSceneElements()
        if (!current.some(el => el.type === 'text')) return
        try {
          applyServerScene(current, sceneGenerationRef.current, undefined, { refreshDimensions: true })
        } catch (error) {
          console.warn('Could not re-measure text after fonts loaded:', error)
        }
      }, 50)
    }
    fontSet.addEventListener('loadingdone', remeasureText)
    return () => {
      fontSet.removeEventListener('loadingdone', remeasureText)
      clearTimeout(timer)
    }
  }, [])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      sceneGenerationRef.current += 1
      sceneLoadStatusRef.current = 'loading'
      const socket = websocketRef.current
      websocketRef.current = null
      socket?.close()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    }
  }, [])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      // initial_elements may arrive before the API exists. HTTP is the fallback;
      // later WebSocket scenes invalidate this request through its generation.
      if (sceneLoadStatusRef.current !== 'ready') void loadExistingElements()
    }
  }, [excalidrawAPI])

  const loadExistingElements = async (): Promise<void> => {
    if (!excalidrawAPIRef.current) return
    const generation = pauseSceneSync()
    try {
      const response = await fetch('/api/elements', { signal: AbortSignal.timeout(10000), headers: TAB }) // the tab sees scratch areas; agents do not
      const result: ApiResponse = await response.json()
      if (generation !== sceneGenerationRef.current) return
      if (!response.ok || !result.success || !Array.isArray(result.elements)) {
        throw new Error(result.error || 'Invalid scene response')
      }
      const filesResponse = await fetch('/api/files', { signal: AbortSignal.timeout(10000) })
      const filesResult = await filesResponse.json() as ApiResponse
      if (generation !== sceneGenerationRef.current) return
      if (!filesResponse.ok || !filesResult.files) {
        throw new Error('Could not load scene files')
      }
      await preloadCanvasFonts()
      if (generation !== sceneGenerationRef.current) return
      await applyLoadedScene(result.elements.map(cleanElementForExcalidraw), generation, filesResult.files)
    } catch (error) {
      failSceneLoad(error, generation)
    }
  }

  const connectWebSocket = (): void => {
    // Guard CONNECTING too: the mount effect and the excalidrawAPI effect can
    // both run before the first socket opens, orphaning a live duplicate
    // connection whose handlers then process every broadcast twice.
    if (websocketRef.current &&
        (websocketRef.current.readyState === WebSocket.CONNECTING ||
         websocketRef.current.readyState === WebSocket.OPEN)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`

    const socket = new WebSocket(wsUrl)
    websocketRef.current = socket

    socket.onopen = () => {
      if (websocketRef.current !== socket) return
      reconnectTriesRef.current = 0
      setIsConnected(true)
      void loadExistingElements()
    }

    socket.onmessage = (event: MessageEvent) => {
      if (websocketRef.current !== socket) return
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        void handleWebSocketMessage(data)
      } catch (error) {
        failSceneLoad(error)
      }
    }

    socket.onclose = (event: CloseEvent) => {
      if (websocketRef.current !== socket) return
      setIsConnected(false)
      pauseSceneSync()

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        reconnectTimerRef.current = setTimeout(connectWebSocket, reconnectTriesRef.current++ ? 3000 : 500)
      }
    }

    socket.onerror = (error: Event) => {
      if (websocketRef.current !== socket) return
      console.error('WebSocket error:', error)
      setIsConnected(false)
      pauseSceneSync()
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    if (SCENE_MUTATIONS.has(data.type) && sceneLoadStatusRef.current !== 'ready') {
      // An incremental event cannot prove that a failed or pending full load
      // was complete. Fetch the current full scene instead of reopening sync.
      void loadExistingElements()
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        // `refreshDimensions` re-wraps bound text from its `originalText`. An
        // update can resize a container (`update_element` with a new width),
        // and without this the label keeps the line breaks computed for the old
        // box — the shape grows, the text stays broken where it was.
        applyServerScene(mergedElements, pauseSceneSync(), undefined, { refreshDimensions: true })
      }

      switch (data.type) {
        case 'initial_elements':
          {
            const generation = pauseSceneSync()
            if (!Array.isArray(data.elements)) throw new Error('Invalid initial scene')
            // Measure the first scene with the real fonts, not a fallback
            await preloadCanvasFonts()
            if (generation !== sceneGenerationRef.current) return
            await applyLoadedScene(data.elements.map(cleanElementForExcalidraw), generation, (data as any).files)
          }
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
            rememberServerFiles((data as any).files)
          }
          break

        case 'file_deleted':
          // Upload it again if an image on the canvas still uses it
          if (typeof (data as any).fileId === 'string') {
            serverFileIdsRef.current.delete((data as any).fileId)
          }
          break

        case 'element_created':
          if (!data.element) throw new Error('Missing created element')
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            // Rebuild against full scene so text/container bindings remain intact.
            mergeAndApplySceneElements([cleanedNewElement])
          }
          break

        case 'element_updated':
          if (!data.element) throw new Error('Missing updated element')
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeAndApplySceneElements([cleanedUpdatedElement])
          }
          break

        case 'element_deleted':
          if (!data.elementId) throw new Error('Missing deleted element ID')
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applyServerScene(filteredElements, pauseSceneSync())
          }
          break

        case 'elements_batch_created':
          if (!Array.isArray(data.elements)) throw new Error('Invalid element batch')
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            mergeAndApplySceneElements(cleanedBatchElements)
          }
          break

        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          // Sync confirmation already handled by HTTP response
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'project_opened':
          // Edits for the old project that never reached the Mac stay as its draft.
          saveDraftNow()
          if (excalidrawAPIRef.current) {
            syncedVersionRef.current = sceneVersion(excalidrawAPIRef.current.getSceneElementsIncludingDeleted())
          }
          if (autoSyncTimerRef.current) { clearTimeout(autoSyncTimerRef.current); autoSyncTimerRef.current = null }
          projectRef.current = (data as any).project
          draftLoadRef.current = null
          setSceneShown(false)
          window.dispatchEvent(new CustomEvent('canvas-project', { detail: (data as any).project }))
          break

        case 'project_renamed': {
          const { from, to } = data as any
          if (projectRef.current === from) projectRef.current = to
          if (sceneProjectRef.current === from) sceneProjectRef.current = to
          void readDraft(from).then(d => d && writeDraft(to, d).then(() => dropDraft(from)))
          window.dispatchEvent(new CustomEvent('canvas-project', { detail: projectRef.current }))
          break
        }

        case 'projects_changed':
          window.dispatchEvent(new CustomEvent('canvas-projects-changed'))
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applyServerScene([], pauseSceneSync())
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              if (!canSyncScene()) throw new Error('Scene is not fully loaded; export is paused')
              // Same option surface as the headless renderer (renderer:'node'),
              // so `--renderer browser` accepts identical flags.
              const opts = data.options ?? {}
              const embedScene = opts.embedScene === true
              if (embedScene && data.format !== 'png') throw new Error('embedScene is only supported for PNG exports')
              const hide = new Set<string>(opts.hide ?? []) // scratch work never goes into an export for an agent
              const allElements = excalidrawAPI.getSceneElements().filter(el => !hide.has(el.id))
              const wanted = opts.elementIds ? new Set(opts.elementIds) : null
              const elements = wanted
                ? allElements.filter(el => wanted.has(el.id) || (el.type === 'text' && (el as any).containerId && wanted.has((el as any).containerId)))
                : allElements
              const exportingFrame = opts.frameId
                ? (allElements.find(el => el.id === opts.frameId && (el.type === 'frame' || el.type === 'magicframe')) as any) ?? null
                : opts.area // Local patch: a marked area crops like a frame that is not in the scene.
                  ? { id: '__area', type: 'frame', x: opts.area.x, y: opts.area.y, width: opts.area.w, height: opts.area.h, angle: 0, name: null, groupIds: [], frameId: null, isDeleted: false } as any
                  : null
              if (opts.frameId && !exportingFrame) throw new Error(`Unknown frame id: ${opts.frameId}`)
              let exportElements = embedScene && exportingFrame
                ? elementsOverlappingBBox({ elements, bounds: exportingFrame, type: 'overlap' })
                  .filter((el: ExcalidrawElement) => !el.frameId || el.frameId === exportingFrame.id)
                : elements
              if (embedScene) {
                const exportedIds = new Set(exportElements.map((el: ExcalidrawElement) => el.id))
                exportElements = exportElements.map((el: ExcalidrawElement) =>
                  el.frameId && !exportedIds.has(el.frameId) ? { ...el, frameId: null } : el)
              }
              const appState = excalidrawAPI.getAppState()
              const exportAppState = {
                ...appState,
                exportBackground: data.background !== false,
                exportEmbedScene: embedScene,
                ...(opts.dark !== undefined ? { exportWithDarkMode: opts.dark } : {}),
                exportScale: opts.scale ?? 1
              }
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: exportAppState,
                  files,
                  exportPadding: opts.padding,
                  exportingFrame
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements: exportElements,
                  appState: exportAppState,
                  files,
                  mimeType: 'image/png',
                  exportPadding: opts.padding,
                  exportingFrame
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, {
                    fitToViewport: true,
                    viewportZoomFactor: data.viewportZoomFactor,
                    animate: true
                  })
                }
              } else if (data.scrollToElementIds !== undefined) {
                if (!Array.isArray(data.scrollToElementIds) ||
                    data.scrollToElementIds.length === 0 ||
                    !data.scrollToElementIds.every(id => typeof id === 'string' && id.length > 0)) {
                  throw new Error('scrollToElementIds must be a non-empty array of element IDs')
                }
                const allElements = excalidrawAPI.getSceneElements()
                const requestedIds = new Set(data.scrollToElementIds)
                const targetElements = allElements.filter(el => requestedIds.has(el.id))
                const foundIds = new Set(targetElements.map(el => el.id))
                const missingIds = data.scrollToElementIds.filter(id => !foundIds.has(id))
                if (missingIds.length > 0) {
                  throw new Error(`Elements not found for IDs: ${missingIds.join(', ')}`)
                }
                excalidrawAPI.scrollToContent(targetElements, {
                  fitToViewport: true,
                  viewportZoomFactor: data.viewportZoomFactor,
                  animate: true
                })
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              if (!canSyncScene()) throw new Error('Scene is not fully loaded; Mermaid import is paused')
              const generation = sceneGenerationRef.current
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)
              if (!canSyncScene() || generation !== sceneGenerationRef.current) return

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                // Regenerate ids so repeated conversions of the same diagram
                // (mermaid emits stable ids like "A", "B") can't collide with
                // elements already on the canvas.
                const convertedElements = convertToExcalidrawElements([...result.elements] as Parameters<typeof convertToExcalidrawElements>[0], { regenerateIds: true })
                // Merge with the existing scene — updateScene() replaces the
                // element list wholesale, and syncToBackend() would otherwise
                // propagate that wipe to the server.
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: [...excalidrawAPI.getSceneElements(), ...convertedElements],
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
      if (data.type === 'initial_elements' || data.type === 'canvas_cleared' || SCENE_MUTATIONS.has(data.type)) {
        failSceneLoad(error)
      }
    }
  }

  // Data format conversion for backend
  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // Main sync function
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options
    // Every caller, including manual sync and Mermaid, must respect a failed
    // restore. A user interaction alone is not evidence of a complete scene.
    if (!canSyncScene()) return

    // Read through the ref: WS message handlers attached at mount capture a
    // stale closure where the excalidrawAPI state is still null.
    const api = excalidrawAPIRef.current
    if (!api) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      // 1. Get current elements
      const currentElements = api.getSceneElements()
      const sentVersion = sceneVersion(api.getSceneElementsIncludingDeleted())
      console.log(`Syncing ${currentElements.length} elements to backend`)

      // Filter out deleted elements
      const activeElements = currentElements.filter(el => !el.isDeleted)

      // 2. Upload image files the server lacks, before the elements that use
      // them. An image element only holds a fileId; without the file the
      // server keeps a dangling reference and a reload shows a broken image.
      // One request per file keeps each body under the server's JSON limit.
      const usedFileIds = new Set(activeElements.flatMap(el =>
        el.type === 'image' && el.fileId ? [el.fileId as string] : []))
      const newFiles = Object.values(api.getFiles()).filter(file =>
        usedFileIds.has(file.id) && file.dataURL && !serverFileIdsRef.current.has(file.id))
      for (const file of newFiles) {
        const fileResponse = await fetch('/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [{
            id: file.id, dataURL: file.dataURL, mimeType: file.mimeType, created: file.created
          }] })
        })
        if (!fileResponse.ok) throw new Error(`Image upload failed: HTTP ${fileResponse.status}`)
        serverFileIdsRef.current.add(file.id)
      }

      // 3. Convert to backend format
      const backendElements = activeElements.map(convertToBackendFormat)

      // 4. Send to backend
      const response = await fetch('/api/elements/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...TAB,
          ...(sceneProjectRef.current ? { 'x-canvas-project': sceneProjectRef.current } : {}),
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result: ApiResponse = await response.json()
        syncedVersionRef.current = sentVersion
        if (sceneProjectRef.current && sceneVersion(api.getSceneElementsIncludingDeleted()) === sentVersion) {
          void dropDraft(sceneProjectRef.current)
        }
        // A fresh thumbnail at most once a minute while the board changes.
        if (Date.now() - thumbAtRef.current > 60_000) { thumbAtRef.current = Date.now(); thumbSoon() }
        setLastSyncTime(new Date())
        console.log(`Sync successful: ${result.count} elements synced`)

        if (!silent) {
          setSyncStatus('success')
          // Reset status after 2 seconds
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else if (response.status === 409) {
        // The Mac has another project open. Keep these edits as this project's draft; the switch
        // events bring the right scene. Never retry into the wrong project.
        console.warn('Sync refused: another project is open; edits kept as a draft')
        saveDraftNow()
        if (autoSyncTimerRef.current) { clearTimeout(autoSyncTimerRef.current); autoSyncTimerRef.current = null }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  const scheduleAutoSync = (): void => {
    if (!canSyncScene() || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  // An ordinary edit: every shape deleted in one undo step, then saved. Undo brings them back.
  const clearCanvas = (): void => {
    const api = excalidrawAPIRef.current
    if (!api || !canSyncScene()) return
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map(el => (el.isDeleted ? el : newElementWith(el, { isDeleted: true }))),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    void syncToBackend({ silent: true })
  }


  return (
    <div className="app" data-theme={theme}>
      {/* Header */}
      <div className="header">
        <Projects beforeSwitch={() => syncToBackend({ silent: true })} saveThumb={saveThumb} />
        <button className={`btn-secondary icons-toggle ${iconsOpen ? 'on' : ''}`} onClick={() => setIconsOpen(o => !o)} aria-label="Icons"><Shapes size={17} /><span className="hb-word">Icons</span></button>
        <Notify api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <Voice api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <Scratch api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            {/* Local patch: saving is automatic; this only reports it. */}
            <span className="save-state" role="status">
              {!isConnected ? 'Offline · kept on this device'
                : syncStatus === 'syncing' ? 'Saving…'
                : syncStatus === 'error' ? 'Not saved yet · kept on this device'
                : 'Saved'}
            </span>
          </div>

          <button className="btn-secondary" onClick={clearCanvas} disabled={!isConnected || sceneLoadStatus !== 'ready'} aria-label="Clear canvas"><Eraser size={17} /><span className="hb-word">Clear</span></button>
        </div>
      </div>

      {sceneLoadStatus !== 'ready' && (sceneLoadStatus === 'failed' || !sceneShown) && (
        <div className="scene-load-status" role={sceneLoadStatus === 'failed' ? 'alert' : 'status'}>
          <span>{sceneLoadStatus === 'failed'
            ? 'Canvas could not be loaded. Sync is paused to protect your saved scene.'
            : 'Loading canvas. Sync is paused until the scene is ready.'}</span>
          {sceneLoadStatus === 'failed' && (
            <button className="btn-secondary" onClick={() => void loadExistingElements()}>Retry loading</button>
          )}
        </div>
      )}

      {/* Canvas Container */}
      <div className="canvas-container">
        <StrokeWidth api={excalidrawAPI as ExcalidrawImperativeAPI | null} />
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
            penDownRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            viewModeEnabled={!sceneShown}
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={(_elements, appState) => {
              if (appState?.theme && appState.theme !== theme) {
                setTheme(appState.theme)
                try {
                  window.localStorage?.setItem('excalidraw-canvas-theme', appState.theme)
                } catch (error) {
                  console.warn('Failed to save theme to localStorage:', error)
                }
              }
              scheduleAutoSync()
              if (!draftTimerRef.current && isDirty()) {
                draftTimerRef.current = setTimeout(() => { draftTimerRef.current = null; saveDraftNow() }, 400)
              }
            }}
            initialData={{
              elements: [],
              appState: {
                theme,
                // Whiteboard-marker defaults: bold black line, big hand-lettered text.
                currentItemStrokeColor: '#1e1e1e',
                currentItemStrokeWidth: 0.5,
                currentItemFontSize: 28,
                currentItemFontFamily: 5,
              }
            }}
          />
          <SelectionDelete api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
          {iconsOpen && <IconPanel api={excalidrawAPI as ExcalidrawImperativeAPI | null} onClose={() => setIconsOpen(false)} />}
        </div>
      </div>
    </div>
  )
}

export default App
