import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  elementsOverlappingBBox,
  exportToBlob,
  exportToSvg,
  newElementWith,
  reconcileElements,
  useHandleLibrary,
} from '@excalidraw/excalidraw'
import type { LibraryPersistedData, LibraryPersistenceAdapter } from '@excalidraw/excalidraw/data/library'
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
  LibraryItems,
  SceneData,
} from '@excalidraw/excalidraw/types'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import { Eraser, Shapes } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconPanel } from './IconPanel'
import { Notify } from './Notify'
import { Projects } from './Projects'
import { Scratch, withoutScratch } from './Scratch'
import { SelectionDelete } from './SelectionDelete'
import { StrokeWidth } from './StrokeWidth'
import { preloadCanvasFonts } from './utils/fonts'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { ServerElement } from './utils/scene'
import { assertScenePreserved, cleanElementForExcalidraw, prepareServerScene } from './utils/scene'
import { Voice } from './Voice'

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
const libraryDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open('excalidraw-canvas', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
const libraryAdapter: LibraryPersistenceAdapter = {
  load: async () => {
    try {
      const db = await libraryDb()
      const items = await new Promise<LibraryItems | undefined>((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(LIBRARY_STORAGE_KEY)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      if (items) return { libraryItems: items }
      const raw = window.localStorage?.getItem(LIBRARY_STORAGE_KEY)
      if (raw) return { libraryItems: JSON.parse(raw) }
      // First visit: start with the canvas's own pack (brand logos, system design, stickies).
      const pack = await fetch('/lib/wren.excalidrawlib')
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
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
  },
}

// Local patch: offline first. Each board has a replica in this browser: its elements and, per element,
// the version the Mac last confirmed (acked). An element whose version differs from its ack is pending:
// the next push sends it. The Mac keeps the newer version of each element, so a retry is safe.
type Replica = { elements: ExcalidrawElement[]; acked: Record<string, string> }
const replicaKey = (project: string) => `replica:${project}`
const stamp = (el: { version?: number; versionNonce?: number }) => `${el.version}:${el.versionNonce ?? 0}`
// The board to open from the replica when the Mac can't be reached.
const LAST_PROJECT_KEY = 'canvas-last-project'
const lastProject = () => {
  try {
    return window.localStorage?.getItem(LAST_PROJECT_KEY) ?? null
  } catch {
    return null
  }
}
const rememberProject = (p: string) => {
  try {
    window.localStorage?.setItem(LAST_PROJECT_KEY, p)
  } catch {
    /* private mode */
  }
}
const idb = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await libraryDb()
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction('kv', mode).objectStore('kv'))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const readReplica = (project: string) =>
  idb<Replica | undefined>('readonly', st => st.get(replicaKey(project))).catch(() => undefined)
const writeReplica = (project: string, r: Replica) =>
  idb('readwrite', st => st.put(r, replicaKey(project))).catch(() => undefined)
const dropReplica = (project: string) => idb('readwrite', st => st.delete(replicaKey(project))).catch(() => undefined)
// Image data once per file, apart from the replica: it never changes, and it is the bulk of the bytes.
const readFile = (id: string) =>
  idb<BinaryFileData | undefined>('readonly', st => st.get(`file:${id}`)).catch(() => undefined)
const writeFile = (f: BinaryFileData) => idb('readwrite', st => st.put(f, `file:${f.id}`)).catch(() => undefined)
// The server's files: a map by id (a scene) or a list (files_added); the canvas wants the map.
type ServerFiles = Record<string, BinaryFileData>
const asFileMap = (files: ServerFiles | BinaryFileData[] | undefined): ServerFiles | undefined =>
  Array.isArray(files) ? Object.fromEntries(files.map(f => [f.id, f])) : files
// Changes whenever any element is added, edited or deleted (Excalidraw bumps `version` on each edit).
const sceneVersion = (els: readonly { version: number }[]): number =>
  els.reduce((sum, el) => sum + el.version, 0) * 1000 + els.length

// Local patch: thumbnail of the open board for the Projects view; scratch areas are left out.
async function postThumb(api: ExcalidrawImperativeAPI, project: string) {
  const elements = withoutScratch(api.getSceneElements())
  if (!elements.length) return
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    maxWidthOrHeight: 480,
    mimeType: 'image/png',
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
  })
  await fetch('/api/projects/thumb', {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-devboard-tab': '1', 'x-canvas-project': project },
    body: blob,
  })
}

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI

interface ExportImageOptions {
  background?: boolean
  dark?: boolean
  scale?: number
  padding?: number
  elementIds?: string[]
  frameId?: string
  area?: { x: number; y: number; w: number; h: number }
  hide?: string[]
  embedScene?: boolean
}

interface WebSocketMessage {
  type: string
  format?: 'png' | 'svg'
  background?: boolean
  options?: ExportImageOptions
  element?: ServerElement
  elements?: ServerElement[]
  elementId?: string
  files?: ServerFiles | BinaryFileData[]
  fileId?: string
  project?: string
  from?: string
  to?: string
  count?: number
  timestamp?: string
  source?: string
  mermaidDiagram?: string
  config?: MermaidConfig
  requestId?: string
  scrollToContent?: boolean
  scrollToElementId?: string
  scrollToElementIds?: string[]
  viewportZoomFactor?: number
  zoom?: number
  offsetX?: number
  offsetY?: number
}

interface ApiResponse {
  success: boolean
  elements?: ServerElement[]
  element?: ServerElement
  files?: ServerFiles
  project?: string
  count?: number
  error?: string
  message?: string
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error'
type SceneLoadStatus = 'loading' | 'ready' | 'failed'
const AUTO_SYNC_DEBOUNCE_MS = 1200
const SCENE_MUTATIONS = new Set([
  'element_created',
  'element_updated',
  'element_deleted',
  'elements_batch_created',
  'elements_merged',
])

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
    validateLibraryUrl: url => {
      const u = new URL(url, window.location.href)
      return (
        u.origin === window.location.origin ||
        ['libraries.excalidraw.com', 'raw.githubusercontent.com'].includes(u.hostname)
      )
    },
  })
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const projectRef = useRef<string | null>(null)
  // The board the scene on screen belongs to. projectRef moves at project_opened, before the new scene
  // arrives; drafts, syncs and thumbnails of the old scene must still name the old board.
  const sceneProjectRef = useRef<string | null>(null)
  const thumbAtRef = useRef(0)
  const saveThumb = async () => {
    const api = excalidrawAPIRef.current,
      project = sceneProjectRef.current
    if (api && project) await postThumb(api, project).catch(() => {})
  }
  // The thumbnail renders the whole board on the main thread (~0.2s on 400 strokes): wait until the pen is up.
  const penDownRef = useRef(false)
  const thumbSoon = (): void => {
    setTimeout(() => (penDownRef.current ? thumbSoon() : void saveThumb()), 1500)
  }
  useEffect(() => {
    const up = () => {
      penDownRef.current = false
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])
  // Per element of the scene's board: the version the Mac confirmed. See Replica.
  const ackedRef = useRef<Map<string, string>>(new Map())
  const isPending = (el: ExcalidrawElement): boolean => ackedRef.current.get(el.id) !== stamp(el)
  const replicaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const replicaVersionRef = useRef<number>(-1)
  const storedFilesRef = useRef<Set<string>>(new Set())
  // A scene (from the Mac or the replica) is on screen; from then on the replica follows it.
  const loadedOnceRef = useRef<boolean>(false)
  const [iconsOpen, setIconsOpen] = useState(false)
  useEffect(() => {
    fetch('/api/projects')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && !projectRef.current) {
          projectRef.current = d.current
          rememberProject(d.current)
        }
      })
      .catch(() => {})
    const onProject = (e: Event) => {
      const project = (e as CustomEvent<string>).detail
      projectRef.current = project
      rememberProject(project)
    }
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
  // Elements the Mac has not confirmed, and whether the last push failed (header text).
  const [unsent, setUnsent] = useState(0)
  const [pushFailed, setPushFailed] = useState(false)
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
  // A scene of the open board is on screen (from the Mac or the replica). From then on the pen stays
  // live through reconnects and reloads: edits wait in the replica and push when sync opens again.
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

  const applySceneUpdateWithoutAutoSync = <K extends keyof AppState>(
    api: ExcalidrawImperativeAPI,
    scene: {
      elements?: SceneData['elements']
      appState?: Pick<AppState, K> | null
      captureUpdate?: SceneData['captureUpdate']
    },
  ): void => {
    suppressAutoSyncCountRef.current += 1
    try {
      api.updateScene(scene)
    } finally {
      setTimeout(() => {
        suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
      }, 0)
    }
  }

  // Write the scene's board to its replica: every live element, and deletes the Mac has not confirmed.
  const saveReplicaNow = (force = false): void => {
    const api = excalidrawAPIRef.current,
      project = sceneProjectRef.current
    if (!api || !project || !loadedOnceRef.current) return
    const all = api.getSceneElementsIncludingDeleted()
    const version = sceneVersion(all)
    if (!force && version === replicaVersionRef.current) return
    setUnsent(all.filter(isPending).length)
    replicaVersionRef.current = version
    void writeReplica(project, {
      elements: all.filter(el => !el.isDeleted || isPending(el)),
      acked: Object.fromEntries(ackedRef.current),
    })
    for (const f of Object.values(api.getFiles())) {
      if (!storedFilesRef.current.has(f.id)) {
        storedFilesRef.current.add(f.id)
        void writeFile(f)
      }
    }
  }
  // Same main-thread rule as the thumbnail: write while the pen is up.
  const replicaSoon = (): void => {
    if (replicaTimerRef.current) return
    replicaTimerRef.current = setTimeout(() => {
      replicaTimerRef.current = null
      if (penDownRef.current) replicaSoon()
      else saveReplicaNow()
    }, 400)
  }
  // The board the Mac has open. Offline, the last board this browser showed.
  const resolveProject = async (): Promise<string | null> => {
    if (!projectRef.current) {
      const p = await fetch('/api/projects')
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
      if (p && !projectRef.current) {
        projectRef.current = p.current
        rememberProject(p.current)
      }
    }
    return projectRef.current
  }
  const addStoredFiles = async (
    api: ExcalidrawImperativeAPI,
    els: readonly ExcalidrawElement[],
    have: ServerFiles = {},
  ): Promise<void> => {
    const ids = [
      ...new Set(els.flatMap(el => (el.type === 'image' && el.fileId && !have[el.fileId] ? [el.fileId] : []))),
    ]
    const found = (await Promise.all(ids.map(readFile))).filter((f): f is BinaryFileData => !!f)
    if (found.length) api.addFiles(found)
  }

  // Open the board from this browser at once, before (or without) the Mac. The Mac's scene merges in later.
  const openReplica = async (): Promise<void> => {
    const project = projectRef.current ?? lastProject()
    const replica = project ? await readReplica(project) : undefined
    const api = excalidrawAPIRef.current
    if (!api || !replica || loadedOnceRef.current || (projectRef.current && projectRef.current !== project)) return
    await addStoredFiles(api, replica.elements)
    if (loadedOnceRef.current) return
    applySceneUpdateWithoutAutoSync(api, { elements: replica.elements, captureUpdate: CaptureUpdateAction.NEVER })
    ackedRef.current = new Map(Object.entries(replica.acked))
    sceneProjectRef.current = project
    replicaVersionRef.current = sceneVersion(api.getSceneElementsIncludingDeleted())
    loadedOnceRef.current = true
    setSceneShown(true)
    console.log(`Opened ${project} from this device: ${replica.elements.length} elements`)
  }

  // A full scene from the Mac. Merge per element with what this browser has not sent yet: the newer
  // version wins (Excalidraw's reconcileElements). A confirmed element the Mac no longer has was deleted
  // there, so it goes. The base is the scene on screen only when it shows the same board; else that
  // board's replica, so one board's shapes never reach another.
  const applyLoadedScene = async (
    incoming: readonly Partial<ExcalidrawElement>[],
    generation: number,
    files?: ServerFiles,
    board?: string,
  ): Promise<void> => {
    if (board && board !== projectRef.current) {
      projectRef.current = board
      rememberProject(board)
      window.dispatchEvent(new CustomEvent('canvas-project', { detail: board }))
    }
    const project = await resolveProject()
    const api = excalidrawAPIRef.current
    if (!api || generation !== sceneGenerationRef.current) return
    const same = loadedOnceRef.current && sceneProjectRef.current === project
    const replica = same || !project ? undefined : await readReplica(project)
    if (generation !== sceneGenerationRef.current) return
    const acked = same ? ackedRef.current : new Map(Object.entries(replica?.acked ?? {}))
    const base: readonly ExcalidrawElement[] = same ? api.getSceneElementsIncludingDeleted() : (replica?.elements ?? [])
    const local = base.filter(el => acked.get(el.id) !== stamp(el))
    const prepared = prepareServerScene(incoming)
    // reconcileElements wants fractional indexes and a brand on the remote side; both sides are full elements here.
    const merged: readonly ExcalidrawElement[] = local.length
      ? reconcileElements(
          local as Parameters<typeof reconcileElements>[0],
          prepared as unknown as Parameters<typeof reconcileElements>[1],
          api.getAppState(),
        )
      : prepared
    // Acked: what the Mac holds. Labels made here from an agent's shape are not on the Mac yet: they go up.
    const fromMac = new Map(incoming.map(el => [el.id, stamp(el)]))
    const nextAcked = new Map<string, string>()
    for (const el of merged) if (fromMac.get(el.id) === stamp(el)) nextAcked.set(el.id, stamp(el))
    if (!same && local.length) await addStoredFiles(api, local, files)
    if (generation !== sceneGenerationRef.current) return
    showScene(merged, generation, files)
    ackedRef.current = nextAcked
    saveReplicaNow(true)
    const pending = merged.filter(isPending).length
    if (pending) {
      console.log(`Merged ${pending} elements kept on this device into ${project}`)
      void syncToBackend({ silent: true })
    }
  }

  // Leaving the tab (app switch, lock screen, close): write the replica and push now, without the
  // debounce. iPad Safari suspends hidden tabs, so a pending timer may never fire.
  const flushOnLeaveRef = useRef<() => void>(() => {})
  flushOnLeaveRef.current = () => {
    saveReplicaNow()
    void syncToBackend({ silent: true })
  }
  // Back online, or back on the tab: connect now, not at the next retry; then push.
  const resumeRef = useRef<() => void>(() => {})
  resumeRef.current = () => {
    const ws = websocketRef.current
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTriesRef.current = 0
      connectWebSocket()
    } else void syncToBackend({ silent: true })
  }
  useEffect(() => {
    const onVisibility = () => (document.visibilityState === 'hidden' ? flushOnLeaveRef.current() : resumeRef.current())
    const onPageHide = () => flushOnLeaveRef.current()
    const onOnline = () => resumeRef.current()
    // The socket can stay half open after the network goes; close it, so the header and retries follow.
    const onOffline = () => websocketRef.current?.close()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    // Ask the browser not to evict the replicas under storage pressure.
    void navigator.storage?.persist?.().catch(() => {})
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const applyServerScene = (
    incoming: readonly Partial<ExcalidrawElement>[],
    generation: number,
    files?: ServerFiles,
    opts: { refreshDimensions?: boolean } = {},
  ): void => {
    showScene(prepareServerScene(incoming, opts), generation, files)
  }

  // Replace the visible scene with a prepared one. restoreElements() can silently filter elements,
  // so the API readback is checked. Deletes this browser has not pushed yet stay in the scene.
  const showScene = (prepared: readonly ExcalidrawElement[], generation: number, files?: ServerFiles): void => {
    const api = excalidrawAPIRef.current
    if (!api || generation !== sceneGenerationRef.current) return
    const previous = api.getSceneElementsIncludingDeleted()
    const ids = new Set(prepared.map(el => el.id))
    const unsentDeletes =
      sceneProjectRef.current === projectRef.current
        ? previous.filter(el => el.isDeleted && !ids.has(el.id) && isPending(el))
        : []
    try {
      if (files) {
        api.addFiles(Object.values(files))
        rememberServerFiles(files)
      }
      applySceneUpdateWithoutAutoSync(api, {
        elements: [...prepared, ...unsentDeletes],
        captureUpdate: CaptureUpdateAction.NEVER,
      })
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

  // Elements the Mac sent one by one (an agent's edit, another tab's push, a push's losers). An element
  // this browser changed and not sent yet stays when it is the newer one; the echo of our own push is a no-op.
  const mergeRemote = (incoming: Partial<ExcalidrawElement>[]): void => {
    const api = excalidrawAPIRef.current
    if (!api || !incoming.length) return
    const current = new Map(api.getSceneElementsIncludingDeleted().map(el => [el.id, el]))
    const newer = (a: Partial<ExcalidrawElement>, b: ExcalidrawElement) =>
      (a.version ?? 0) > b.version || (a.version === b.version && (a.versionNonce ?? 0) < b.versionNonce)
    const take = new Map<string, Partial<ExcalidrawElement>>()
    for (const el of incoming) {
      const id = el.id
      if (!id) continue
      const cur = current.get(id)
      if (cur && stamp(cur) === stamp(el)) {
        ackedRef.current.set(cur.id, stamp(cur))
        continue
      }
      if (cur && isPending(cur) && !newer(el, cur)) continue
      if (!cur && el.isDeleted) continue
      take.set(id, el)
      ackedRef.current.set(id, stamp(el))
    }
    if (!take.size) return
    const next: Partial<ExcalidrawElement>[] = []
    for (const el of api.getSceneElements()) {
      const inc = take.get(el.id)
      if (!inc) {
        next.push(el)
        continue
      }
      take.delete(el.id)
      if (!inc.isDeleted) next.push({ ...el, ...inc })
    }
    next.push(...[...take.values()].filter(el => !el.isDeleted))
    // `refreshDimensions` re-wraps bound text from its `originalText`. An
    // update can resize a container (`update_element` with a new width),
    // and without this the label keeps the line breaks computed for the old
    // box — the shape grows, the text stays broken where it was.
    applyServerScene(next, pauseSceneSync(), undefined, { refreshDimensions: true })
    saveReplicaNow(true)
    if (api.getSceneElementsIncludingDeleted().some(isPending)) pushSoon()
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once at mount; the handler reads the latest state through refs
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once at mount; the handlers read the latest state through refs
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the API arrives; the loaders read the latest state through refs
  useEffect(() => {
    if (excalidrawAPI) {
      // initial_elements may arrive before the API exists. HTTP is the fallback;
      // later WebSocket scenes invalidate this request through its generation.
      void openReplica()
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
      const filesResult = (await filesResponse.json()) as ApiResponse
      if (generation !== sceneGenerationRef.current) return
      if (!filesResponse.ok || !filesResult.files) {
        throw new Error('Could not load scene files')
      }
      await preloadCanvasFonts()
      if (generation !== sceneGenerationRef.current) return
      await applyLoadedScene(
        result.elements.map(cleanElementForExcalidraw),
        generation,
        filesResult.files,
        result.project,
      )
    } catch (error) {
      failSceneLoad(error, generation)
    }
  }

  const connectWebSocket = (): void => {
    // Guard CONNECTING too: the mount effect and the excalidrawAPI effect can
    // both run before the first socket opens, orphaning a live duplicate
    // connection whose handlers then process every broadcast twice.
    if (
      websocketRef.current &&
      (websocketRef.current.readyState === WebSocket.CONNECTING || websocketRef.current.readyState === WebSocket.OPEN)
    ) {
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

      switch (data.type) {
        case 'initial_elements':
          {
            const generation = pauseSceneSync()
            if (!Array.isArray(data.elements)) throw new Error('Invalid initial scene')
            // Measure the first scene with the real fonts, not a fallback
            await preloadCanvasFonts()
            if (generation !== sceneGenerationRef.current) return
            await applyLoadedScene(
              data.elements.map(cleanElementForExcalidraw),
              generation,
              asFileMap(data.files),
              data.project,
            )
          }
          break

        case 'files_added':
          if (Array.isArray(data.files)) {
            excalidrawAPI.addFiles(data.files)
            rememberServerFiles(data.files)
          }
          break

        case 'file_deleted':
          // Upload it again if an image on the canvas still uses it
          if (typeof data.fileId === 'string') {
            serverFileIdsRef.current.delete(data.fileId)
          }
          break

        case 'element_created':
          if (!data.element) throw new Error('Missing created element')
          if (data.element) {
            // Rebuild against full scene so text/container bindings remain intact.
            mergeRemote([cleanElementForExcalidraw(data.element)])
          }
          break

        case 'element_updated':
          if (!data.element) throw new Error('Missing updated element')
          if (data.element) {
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeRemote([cleanElementForExcalidraw(data.element)])
          }
          break

        case 'element_deleted':
          if (!data.elementId) throw new Error('Missing deleted element ID')
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applyServerScene(filteredElements, pauseSceneSync())
            ackedRef.current.delete(data.elementId)
            saveReplicaNow(true)
          }
          break

        case 'elements_batch_created':
          if (!Array.isArray(data.elements)) throw new Error('Invalid element batch')
          if (data.elements) {
            mergeRemote(data.elements.map(cleanElementForExcalidraw))
          }
          break

        case 'elements_merged':
          if (!Array.isArray(data.elements)) throw new Error('Invalid merged elements')
          mergeRemote(data.elements.map(cleanElementForExcalidraw))
          break

        case 'elements_synced':
          // Tabs push; a full overwrite comes from an agent. Take the whole scene again.
          void loadExistingElements()
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'project_opened':
          // Edits for the old project that never reached the Mac stay in its replica.
          saveReplicaNow(true)
          if (autoSyncTimerRef.current) {
            clearTimeout(autoSyncTimerRef.current)
            autoSyncTimerRef.current = null
          }
          projectRef.current = data.project ?? null
          if (data.project) rememberProject(data.project)
          setSceneShown(false)
          window.dispatchEvent(new CustomEvent('canvas-project', { detail: data.project }))
          break

        case 'project_renamed': {
          const { from, to } = data
          if (!from || !to) break
          if (projectRef.current === from) projectRef.current = to
          if (sceneProjectRef.current === from) sceneProjectRef.current = to
          void readReplica(from).then(r => r && writeReplica(to, r).then(() => dropReplica(from)))
          if (lastProject() === from) rememberProject(to)
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
                ? allElements.filter(
                    el => wanted.has(el.id) || (el.type === 'text' && el.containerId && wanted.has(el.containerId)),
                  )
                : allElements
              const isFrame = (el: NonDeleted<ExcalidrawElement>): el is NonDeleted<ExcalidrawFrameLikeElement> =>
                el.type === 'frame' || el.type === 'magicframe'
              const exportingFrame: ExcalidrawFrameLikeElement | null = opts.frameId
                ? ((allElements.find(el => el.id === opts.frameId && isFrame(el)) as
                    | NonDeleted<ExcalidrawFrameLikeElement>
                    | undefined) ?? null)
                : opts.area // Local patch: a marked area crops like a frame that is not in the scene.
                  ? ({
                      id: '__area',
                      type: 'frame',
                      x: opts.area.x,
                      y: opts.area.y,
                      width: opts.area.w,
                      height: opts.area.h,
                      angle: 0,
                      name: null,
                      groupIds: [],
                      frameId: null,
                      isDeleted: false,
                    } as unknown as ExcalidrawFrameLikeElement)
                  : null
              if (opts.frameId && !exportingFrame) throw new Error(`Unknown frame id: ${opts.frameId}`)
              let exportElements =
                embedScene && exportingFrame
                  ? elementsOverlappingBBox({ elements, bounds: exportingFrame, type: 'overlap' }).filter(
                      (el: ExcalidrawElement) => !el.frameId || el.frameId === exportingFrame.id,
                    )
                  : elements
              if (embedScene) {
                const exportedIds = new Set(exportElements.map((el: ExcalidrawElement) => el.id))
                exportElements = exportElements.map((el: ExcalidrawElement) =>
                  el.frameId && !exportedIds.has(el.frameId) ? { ...el, frameId: null } : el,
                )
              }
              const appState = excalidrawAPI.getAppState()
              const exportAppState = {
                ...appState,
                exportBackground: data.background !== false,
                exportEmbedScene: embedScene,
                ...(opts.dark !== undefined ? { exportWithDarkMode: opts.dark } : {}),
                exportScale: opts.scale ?? 1,
              }
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: exportAppState,
                  files,
                  exportPadding: opts.padding,
                  exportingFrame,
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString,
                  }),
                })
              } else {
                const blob = await exportToBlob({
                  elements: exportElements,
                  appState: exportAppState,
                  files,
                  mimeType: 'image/png',
                  exportPadding: opts.padding,
                  exportingFrame,
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
                        data: base64,
                      }),
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message,
                      }),
                    }).catch(() => {})
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed',
                    }),
                  }).catch(() => {})
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
                  error: (exportError as Error).message,
                }),
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
                    animate: true,
                  })
                }
              } else if (data.scrollToElementIds !== undefined) {
                if (
                  !Array.isArray(data.scrollToElementIds) ||
                  data.scrollToElementIds.length === 0 ||
                  !data.scrollToElementIds.every(id => typeof id === 'string' && id.length > 0)
                ) {
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
                  animate: true,
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
                // Direct zoom/scroll control. Only the keys given change: updateScene merges them,
                // though its type asks for every key of the pick.
                const appState = {
                  ...(data.zoom !== undefined ? { zoom: { value: data.zoom as AppState['zoom']['value'] } } : {}),
                  ...(data.offsetX !== undefined ? { scrollX: data.offsetX } : {}),
                  ...(data.offsetY !== undefined ? { scrollY: data.offsetY } : {}),
                } as Pick<AppState, 'zoom' | 'scrollX' | 'scrollY'>
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
                  message: 'Viewport updated',
                }),
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message,
                }),
              }).catch(() => {})
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              if (!canSyncScene()) throw new Error('Scene is not fully loaded; Mermaid import is paused')
              const generation = sceneGenerationRef.current
              const result = await convertMermaidToExcalidraw(
                data.mermaidDiagram,
                data.config || DEFAULT_MERMAID_CONFIG,
              )
              if (!canSyncScene() || generation !== sceneGenerationRef.current) return

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                // Regenerate ids so repeated conversions of the same diagram
                // (mermaid emits stable ids like "A", "B") can't collide with
                // elements already on the canvas.
                const convertedElements = convertToExcalidrawElements(
                  [...result.elements] as Parameters<typeof convertToExcalidrawElements>[0],
                  { regenerateIds: true },
                )
                // Merge with the existing scene — updateScene() replaces the
                // element list wholesale, and syncToBackend() would otherwise
                // propagate that wipe to the server.
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: [...excalidrawAPI.getSceneElements(), ...convertedElements],
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY,
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

  // Push: send the elements the Mac has not confirmed, deletes included. Ack each by the version sent,
  // so an edit made while the request runs stays pending. Losers come back and replace ours.
  const pushAgainRef = useRef(false)
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options
    // Every caller, including manual sync and Mermaid, must respect a failed
    // restore. A user interaction alone is not evidence of a complete scene.
    if (!canSyncScene()) return

    // Read through the ref: WS message handlers attached at mount capture a
    // stale closure where the excalidrawAPI state is still null.
    const api = excalidrawAPIRef.current
    if (!api) return

    if (syncInFlightRef.current) {
      pushAgainRef.current = true
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    const sent = api.getSceneElementsIncludingDeleted().filter(isPending)
    if (!sent.length) return
    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }
    const project = sceneProjectRef.current

    try {
      // Upload image files the server lacks, before the elements that use
      // them. An image element only holds a fileId; without the file the
      // server keeps a dangling reference and a reload shows a broken image.
      // One request per file keeps each body under the server's JSON limit.
      const usedFileIds = new Set(
        sent.flatMap(el => (el.type === 'image' && !el.isDeleted && el.fileId ? [el.fileId as string] : [])),
      )
      const newFiles = Object.values(api.getFiles()).filter(
        file => usedFileIds.has(file.id) && file.dataURL && !serverFileIdsRef.current.has(file.id),
      )
      for (const file of newFiles) {
        const fileResponse = await fetch('/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [
              {
                id: file.id,
                dataURL: file.dataURL,
                mimeType: file.mimeType,
                created: file.created,
              },
            ],
          }),
        })
        if (!fileResponse.ok) throw new Error(`Image upload failed: HTTP ${fileResponse.status}`)
        serverFileIdsRef.current.add(file.id)
      }

      const response = await fetch('/api/elements/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...TAB,
          ...(project ? { 'x-canvas-project': project } : {}),
        },
        body: JSON.stringify({ elements: sent }),
      })

      if (response.ok) {
        const result = (await response.json()) as {
          applied: { id: string; version: number; versionNonce: number }[]
          rejected: ServerElement[]
        }
        // The scene moved to another board meanwhile: its acks are not this board's.
        if (sceneProjectRef.current !== project) return
        setPushFailed(false)
        for (const a of result.applied) ackedRef.current.set(a.id, stamp(a))
        if (result.rejected.length) mergeRemote(result.rejected.map(cleanElementForExcalidraw))
        saveReplicaNow(true)
        // A fresh thumbnail at most once a minute while the board changes.
        if (Date.now() - thumbAtRef.current > 60_000) {
          thumbAtRef.current = Date.now()
          thumbSoon()
        }

        if (!silent) {
          setSyncStatus('success')
          // Reset status after 2 seconds
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else if (response.status === 409) {
        // The Mac has another project open. These edits stay in this board's replica; the switch
        // events bring the right scene. Never retry into the wrong project.
        console.warn('Push refused: another project is open; edits kept on this device')
        saveReplicaNow(true)
        if (autoSyncTimerRef.current) {
          clearTimeout(autoSyncTimerRef.current)
          autoSyncTimerRef.current = null
        }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Push failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Push error:', error)
      setPushFailed(true)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
      if (pushAgainRef.current) {
        pushAgainRef.current = false
        pushSoon()
      }
    }
  }

  const pushSoon = (): void => {
    if (!canSyncScene()) return
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }
    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  const scheduleAutoSync = (): void => {
    if (!userInteractedRef.current || suppressAutoSyncCountRef.current > 0) return
    pushSoon()
  }

  // An ordinary edit: every shape deleted in one undo step, then saved. Undo brings them back.
  const clearCanvas = (): void => {
    const api = excalidrawAPIRef.current
    if (!api || !canSyncScene()) return
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map(el => (el.isDeleted ? el : newElementWith(el, { isDeleted: true }))),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    void syncToBackend({ silent: true })
  }

  return (
    <div className="app" data-theme={theme}>
      {/* Header */}
      <div className="header">
        <Projects beforeSwitch={() => syncToBackend({ silent: true })} saveThumb={saveThumb} />
        <button
          type="button"
          className={`btn-secondary icons-toggle ${iconsOpen ? 'on' : ''}`}
          onClick={() => setIconsOpen(o => !o)}
          aria-label="Icons"
        >
          <Shapes size={17} />
          <span className="hb-word">Icons</span>
        </button>
        <Notify api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <Voice api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <Scratch api={excalidrawAPI as ExcalidrawImperativeAPI | null} flush={() => syncToBackend({ silent: true })} />
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            {/* Local patch: saving is automatic; this only reports it. */}
            <span className="save-state" role="status">
              {!isConnected
                ? 'Offline · kept on this device'
                : unsent && pushFailed
                  ? 'Not saved yet · kept on this device'
                  : unsent || syncStatus === 'syncing'
                    ? 'Saving…'
                    : 'Saved'}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={clearCanvas}
            disabled={!isConnected || sceneLoadStatus !== 'ready'}
            aria-label="Clear canvas"
          >
            <Eraser size={17} />
            <span className="hb-word">Clear</span>
          </button>
        </div>
      </div>

      {sceneLoadStatus !== 'ready' && !sceneShown && (
        <div className="scene-load-status" role={sceneLoadStatus === 'failed' ? 'alert' : 'status'}>
          <span>
            {sceneLoadStatus === 'failed'
              ? 'Canvas could not be loaded. Sync is paused to protect your saved scene.'
              : 'Loading canvas. Sync is paused until the scene is ready.'}
          </span>
          {sceneLoadStatus === 'failed' && (
            <button type="button" className="btn-secondary" onClick={() => void loadExistingElements()}>
              Retry loading
            </button>
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
              if (loadedOnceRef.current && sceneVersion(_elements) !== replicaVersionRef.current) replicaSoon()
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
              },
            }}
          />
          <SelectionDelete
            api={excalidrawAPI as ExcalidrawImperativeAPI | null}
            flush={() => syncToBackend({ silent: true })}
          />
          {iconsOpen && (
            <IconPanel api={excalidrawAPI as ExcalidrawImperativeAPI | null} onClose={() => setIconsOpen(false)} />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
