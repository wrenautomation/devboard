import {
  CaptureUpdateAction,
  Excalidraw,
  newElementWith,
  reconcileElements,
  useHandleLibrary,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI, SceneData } from '@excalidraw/excalidraw/types'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import { useEffect, useRef, useState } from 'react'
import { fetchJson, getJson, post, postJson, TAB } from './api'
import { BoardLoading } from './BoardLoading'
import { type ExportImageOptions, exportForServer } from './export'
import { IconPanel } from './IconPanel'
import { Eraser, Shapes } from './icons'
import { openMedia, renderEmbeddable, validateEmbeddable } from './Media'
import { Notify } from './Notify'
import { Projects } from './Projects'
import { Scratch } from './Scratch'
import { SelectionDelete } from './SelectionDelete'
import { StrokeWidth } from './StrokeWidth'
import {
  asFileMap,
  dropReplica,
  fetchFile,
  lastProject,
  libraryAdapter,
  readFile,
  readReplica,
  rememberProject,
  type ServerFiles,
  sceneVersion,
  stamp,
  writeFile,
  writeReplica,
} from './store'
import { Touch } from './Touch'
import { useThumbs } from './thumbs'
import { canvasFontsLoaded, preloadCanvasFonts } from './utils/fonts'
import { importMermaid } from './utils/mermaidConverter'
import type { ServerElement } from './utils/scene'
import { assertScenePreserved, cleanElementForExcalidraw, prepareServerScene } from './utils/scene'
import { Voice } from './Voice'
import { applyViewport } from './viewport'

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI

interface WebSocketMessage {
  type: string
  format?: 'png' | 'svg'
  background?: boolean
  options?: ExportImageOptions
  element?: ServerElement
  elements?: ServerElement[]
  elementId?: string
  files?: ServerFiles | BinaryFileData[]
  fileIds?: string[]
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
  // The board the Mac has open, as this tab last heard. Differs from sceneProjectRef during a preview.
  const serverBoardRef = useRef<string | null>(null)
  const thumbs = useThumbs(excalidrawAPIRef, sceneProjectRef)
  // Per element of the scene's board: the version the Mac confirmed. See Replica.
  const ackedRef = useRef<Map<string, string>>(new Map())
  // Boards whose text was sized with this device's loaded fonts (see Replica.measured)
  const measuredRef = useRef<Set<string>>(new Set())
  const isPending = (el: ExcalidrawElement): boolean => ackedRef.current.get(el.id) !== stamp(el)
  const replicaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const replicaVersionRef = useRef<number>(-1)
  const storedFilesRef = useRef<Set<string>>(new Set())
  // A scene (from the Mac or the replica) is on screen; from then on the replica follows it.
  const loadedOnceRef = useRef<boolean>(false)
  const [iconsOpen, setIconsOpen] = useState(false)
  useEffect(() => {
    void getJson<{ current: string }>('/api/projects').then(d => {
      if (d && !projectRef.current) {
        projectRef.current = d.current
        rememberProject(d.current)
      }
    })
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
    for (const file of list as ({ id?: unknown } | string)[]) {
      const id = typeof file === 'string' ? file : file?.id
      if (typeof id === 'string') serverFileIdsRef.current.add(id)
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
      measured: measuredRef.current.has(project),
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
      if (thumbs.penDown.current) replicaSoon()
      else saveReplicaNow()
    }, 400)
  }
  // The board the Mac has open. Offline, the last board this browser showed.
  const resolveProject = async (): Promise<string | null> => {
    if (!projectRef.current) {
      const p = await getJson<{ current: string }>('/api/projects')
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
  // Images a scene uses that the canvas lacks: this device first, then the Mac, one cached request each.
  const loadSceneFiles = async (
    api: ExcalidrawImperativeAPI,
    els: readonly ExcalidrawElement[],
    board?: string,
  ): Promise<void> => {
    const have = api.getFiles()
    const ids = [
      ...new Set(els.flatMap(el => (el.type === 'image' && el.fileId && !have[el.fileId] ? [el.fileId] : []))),
    ]
    const found = await Promise.all(ids.map(async id => (await readFile(id)) ?? (await fetchFile(id, board))))
    const list = found.filter((f): f is BinaryFileData => !!f)
    for (const f of list) storedFilesRef.current.add(f.id)
    if (list.length) api.addFiles(list)
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

  // A board's scene from the Mac by delta: the tab names what it holds unchanged (scene on screen, else the
  // board's replica); the Mac sends every id and only the elements that differ. Design: designs/2026-11-02-board-pins.md.
  const pullScene = async (
    board: string,
  ): Promise<{ elements: ServerElement[]; fileIds: string[]; unchanged: boolean }> => {
    const api = excalidrawAPIRef.current
    const same = loadedOnceRef.current && sceneProjectRef.current === board
    const replica = same ? undefined : await readReplica(board)
    const acked = same ? ackedRef.current : new Map(Object.entries(replica?.acked ?? {}))
    const base = same && api ? api.getSceneElementsIncludingDeleted() : (replica?.elements ?? [])
    const held = new Map(base.filter(el => acked.get(el.id) === stamp(el)).map(el => [el.id, el]))
    const r = await postJson<{ ids: string[]; changed: ServerElement[]; fileIds: string[] }>(
      '/api/projects/scene',
      { name: board, have: Object.fromEntries([...held.values()].map(el => [el.id, stamp(el)])) },
      TAB,
    )
    const changed = new Map(r.changed.map(el => [el.id, el]))
    const elements = r.ids.map(id => changed.get(id) ?? (held.get(id) as unknown as ServerElement))
    if (elements.some(el => !el)) throw new Error('Scene delta missed an element')
    // the scene on screen is the Mac's, element for element, with nothing waiting to go up
    const live = new Set(base.flatMap(el => (el.isDeleted ? [] : [el.id])))
    const unchanged =
      same &&
      !r.changed.length &&
      base.every(el => acked.get(el.id) === stamp(el)) &&
      live.size === r.ids.length &&
      r.ids.every(id => live.has(id))
    return { elements, fileIds: r.fileIds, unchanged }
  }

  // Tap on a board: draw its replica at once; the Mac's delta merges when the switch lands.
  const previewBoard = async (board: string): Promise<boolean> => {
    const api = excalidrawAPIRef.current
    if (!api || board === sceneProjectRef.current) return false
    saveReplicaNow()
    const replica = await readReplica(board)
    if (!replica?.elements.length) return false
    const generation = pauseSceneSync()
    await loadSceneFiles(api, replica.elements, board)
    if (generation !== sceneGenerationRef.current) return false
    projectRef.current = board
    rememberProject(board)
    window.dispatchEvent(new CustomEvent('canvas-project', { detail: board }))
    ackedRef.current = new Map(Object.entries(replica.acked))
    if (replica.measured) measuredRef.current.add(board)
    // already prepared: shown here before, or by the preload; no second conversion
    showScene(replica.elements, generation)
    replicaVersionRef.current = sceneVersion(api.getSceneElementsIncludingDeleted())
    return true
  }
  // Tap: the replica draws at once; open and pull run together (a closed board takes no writes, so the pull
  // cannot go stale before the open). The old board's thumbnail renders after the new board is up.
  const switchingRef = useRef<string | null>(null)
  const [loadingBoard, setLoadingBoard] = useState<string | null>(null)
  const switchBoard = async (board: string): Promise<void> => {
    performance.mark('devboard:switch', { detail: { board } })
    const shot = thumbs.shot()
    await syncToBackend({ silent: true })
    switchingRef.current = board
    try {
      const shown = await previewBoard(board)
      if (!shown) setLoadingBoard(board)
      // no replica: the old board stays on screen, paused, until the new one lands
      const generation = shown ? sceneGenerationRef.current : pauseSceneSync()
      const [, scene] = await Promise.all([postJson('/api/projects/open', { name: board }), pullScene(board)])
      await landScene(board, scene, generation)
    } catch (error) {
      void loadExistingElements()
      throw error
    } finally {
      switchingRef.current = null
      setLoadingBoard(null)
    }
    if (shot) thumbs.soon(shot)
  }

  // Idle: bring the replicas (and images) of recent boards up to date, so a switch to one draws at once and
  // pulls almost nothing. A board with edits not sent yet is left alone.
  const preloadBoards = async (): Promise<void> => {
    const list = await getJson<{ current: string; boards: { path: string; updated: number }[] }>('/api/projects')
    if (!list) return
    const recent = list.boards
      .filter(b => b.path !== list.current)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 6)
    for (const { path } of recent) {
      const busy = () => sceneProjectRef.current === path || projectRef.current === path
      const replica = await readReplica(path)
      if (busy() || replica?.elements.some(el => replica.acked[el.id] !== stamp(el))) continue
      const { elements, fileIds } = await pullScene(path).catch(() => ({ elements: null, fileIds: [] }))
      if (!elements || busy()) continue
      const fresh =
        replica &&
        elements.length === replica.elements.length &&
        elements.every((el, i) => el === (replica.elements[i] as unknown))
      const measured = canvasFontsLoaded()
      if (!fresh || (measured && !replica?.measured)) {
        const prepared = prepareServerScene(elements.map(cleanElementForExcalidraw), { refreshDimensions: measured })
        await writeReplica(path, {
          elements: [...prepared],
          acked: Object.fromEntries(elements.map(el => [el.id, stamp(el)])),
          measured,
        })
      }
      const wanted = new Set(fileIds)
      for (const el of elements)
        if (el.type === 'image' && el.fileId && wanted.has(el.fileId) && !(await readFile(el.fileId)))
          await fetchFile(el.fileId, path)
    }
  }
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preloadAtRef = useRef(0)
  // at most once a minute: a switch already pulls its own board
  const preloadSoon = (): void => {
    if (Date.now() - preloadAtRef.current < 60_000) return
    preloadAtRef.current = Date.now()
    if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current)
    preloadTimerRef.current = setTimeout(() => void preloadBoards().catch(() => {}), 4000)
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
    // stored sizes come from other font metrics (server, another browser): re-measure with this tab's fonts
    const prepared = prepareServerScene(incoming, { refreshDimensions: canvasFontsLoaded() })
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
    await loadSceneFiles(api, merged)
    if (generation !== sceneGenerationRef.current) return
    showScene(merged, generation, files)
    ackedRef.current = nextAcked
    saveReplicaNow(true)
    preloadSoon()
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
    // switch timing: scripts/switch-bench.mjs
    performance.mark('devboard:scene', { detail: { board: sceneProjectRef.current, n: prepared.length } })
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

  // A pulled scene lands. Nothing changed and the text already sized here: the scene on screen stays as is.
  // Else the full merge, which sizes text with the loaded fonts.
  const landScene = async (
    board: string,
    scene: Awaited<ReturnType<typeof pullScene>>,
    generation: number,
  ): Promise<void> => {
    if (generation !== sceneGenerationRef.current) return
    serverBoardRef.current = board
    rememberServerFiles(scene.fileIds)
    if (scene.unchanged && measuredRef.current.has(board)) {
      sceneLoadStatusRef.current = 'ready'
      setSceneLoadStatus('ready')
      setSceneShown(true)
      preloadSoon()
      return
    }
    await preloadCanvasFonts()
    if (generation !== sceneGenerationRef.current) return
    const measured = canvasFontsLoaded()
    await applyLoadedScene(scene.elements.map(cleanElementForExcalidraw), generation, undefined, board)
    if (measured && generation === sceneGenerationRef.current) {
      measuredRef.current.add(board)
      saveReplicaNow(true)
    }
  }

  // board: the one the Mac just opened (project_opened), which saves asking for it
  const loadExistingElements = async (board?: string): Promise<void> => {
    if (!excalidrawAPIRef.current) return
    const generation = pauseSceneSync()
    try {
      const current = board ?? (await fetchJson<{ current: string }>('/api/projects', { timeoutMs: 10000 })).current
      if (generation !== sceneGenerationRef.current) return
      serverBoardRef.current = current
      await landScene(current, await pullScene(current), generation)
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
    // scene=pull: no full scene on connect or switch; this tab pulls deltas (pullScene)
    const wsUrl = `${protocol}//${window.location.host}/?scene=pull`

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

    // an edit for the board the Mac still has open, while this tab previews the next one: the pull brings it
    if (SCENE_MUTATIONS.has(data.type) && serverBoardRef.current !== sceneProjectRef.current) return

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
            rememberServerFiles(data.fileIds)
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
          serverBoardRef.current = data.project ?? null
          if (data.project) rememberProject(data.project)
          // a preview of this board stays on screen while its delta comes
          if (sceneProjectRef.current !== data.project) setSceneShown(false)
          window.dispatchEvent(new CustomEvent('canvas-project', { detail: data.project }))
          // this tab's own switch pulls its board itself
          if (data.project !== switchingRef.current) void loadExistingElements(data.project ?? undefined)
          break

        case 'project_renamed': {
          const { from, to } = data
          if (!from || !to) break
          if (projectRef.current === from) projectRef.current = to
          if (sceneProjectRef.current === from) sceneProjectRef.current = to
          if (serverBoardRef.current === from) serverBoardRef.current = to
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
          if (data.requestId)
            await exportForServer(excalidrawAPI, { ...data, requestId: data.requestId }, canSyncScene())
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId)
            await applyViewport(excalidrawAPI, { ...data, requestId: data.requestId }, appState =>
              applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState }),
            )
          break

        case 'mermaid_convert': {
          if (!data.mermaidDiagram) break
          try {
            if (!canSyncScene()) throw new Error('Scene is not fully loaded; Mermaid import is paused')
            const generation = sceneGenerationRef.current
            const n = await importMermaid(
              excalidrawAPI,
              data.mermaidDiagram,
              data.config,
              scene => applySceneUpdateWithoutAutoSync(excalidrawAPI, scene),
              () => canSyncScene() && generation === sceneGenerationRef.current,
            )
            if (n) await syncToBackend()
          } catch (error) {
            console.error('Mermaid import failed:', error)
          }
          break
        }

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
        const { id, dataURL, mimeType, created } = file
        const upload = await post('/api/files', { files: [{ id, dataURL, mimeType, created }] })
        if (!upload.ok) throw new Error(`Image upload failed: HTTP ${upload.status}`)
        serverFileIdsRef.current.add(file.id)
      }

      const response = await post<{
        applied: { id: string; version: number; versionNonce: number }[]
        rejected: ServerElement[]
        error?: string
      }>('/api/elements/push', { elements: sent }, { ...TAB, ...(project ? { 'x-canvas-project': project } : {}) })

      if (response.ok) {
        const result = response.data
        // The scene moved to another board meanwhile: its acks are not this board's.
        if (sceneProjectRef.current !== project) return
        setPushFailed(false)
        for (const a of result.applied) ackedRef.current.set(a.id, stamp(a))
        if (result.rejected.length) mergeRemote(result.rejected.map(cleanElementForExcalidraw))
        saveReplicaNow(true)
        thumbs.changed()

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
        console.error('Push failed:', response.data.error)
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
        <Projects switchBoard={switchBoard} saveThumb={() => thumbs.save()} />
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

      {sceneLoadStatus === 'failed' && !sceneShown && (
        <div className="scene-load-status" role="alert">
          <span>Canvas could not be loaded. Sync is paused to protect your saved scene.</span>
          <button type="button" className="btn-secondary" onClick={() => void loadExistingElements()}>
            Retry loading
          </button>
        </div>
      )}

      {/* Canvas Container */}
      <div className="canvas-container">
        <BoardLoading board={loadingBoard ?? (sceneLoadStatus === 'loading' && !sceneShown ? lastProject() : null)} />
        <StrokeWidth api={excalidrawAPI as ExcalidrawImperativeAPI | null} />
        <Touch api={excalidrawAPI as ExcalidrawImperativeAPI | null} />
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
            thumbs.penDown.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            viewModeEnabled={!sceneShown}
            validateEmbeddable={validateEmbeddable}
            renderEmbeddable={renderEmbeddable}
            onLinkOpen={openMedia}
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
