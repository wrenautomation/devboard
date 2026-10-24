// What this browser keeps: the library (IndexedDB), each board's replica and its image files, and the
// last board it showed. Offline first: a board opens from here before (or without) the Mac.
import type { LibraryPersistedData, LibraryPersistenceAdapter } from '@excalidraw/excalidraw/data/library'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, LibraryItems } from '@excalidraw/excalidraw/types'
import { loadPack } from './api'

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
export const libraryAdapter: LibraryPersistenceAdapter = {
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
      const pack = await loadPack()
      if (!pack.length) return null
      await libraryAdapter.save({ libraryItems: pack })
      return { libraryItems: pack }
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
export type Replica = { elements: ExcalidrawElement[]; acked: Record<string, string> }
const replicaKey = (project: string) => `replica:${project}`
export const stamp = (el: { version?: number; versionNonce?: number }) => `${el.version}:${el.versionNonce ?? 0}`
// The board to open from the replica when the Mac can't be reached.
const LAST_PROJECT_KEY = 'canvas-last-project'
export const lastProject = () => {
  try {
    return window.localStorage?.getItem(LAST_PROJECT_KEY) ?? null
  } catch {
    return null
  }
}
export const rememberProject = (p: string) => {
  try {
    window.localStorage?.setItem(LAST_PROJECT_KEY, p)
  } catch {
    /* private mode */
  }
}
const idb = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await libraryDb()
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction('kv', mode).objectStore('kv'))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
export const readReplica = (project: string) =>
  idb<Replica | undefined>('readonly', st => st.get(replicaKey(project))).catch(() => undefined)
export const writeReplica = (project: string, r: Replica) =>
  idb('readwrite', st => st.put(r, replicaKey(project))).catch(() => undefined)
export const dropReplica = (project: string) =>
  idb('readwrite', st => st.delete(replicaKey(project))).catch(() => undefined)
// Image data once per file, apart from the replica: it never changes, and it is the bulk of the bytes.
export const readFile = (id: string) =>
  idb<BinaryFileData | undefined>('readonly', st => st.get(`file:${id}`)).catch(() => undefined)
export const writeFile = (f: BinaryFileData) => idb('readwrite', st => st.put(f, `file:${f.id}`)).catch(() => undefined)
// The server's files: a map by id (a scene) or a list (files_added); the canvas wants the map.
export type ServerFiles = Record<string, BinaryFileData>
export const asFileMap = (files: ServerFiles | BinaryFileData[] | undefined): ServerFiles | undefined =>
  Array.isArray(files) ? Object.fromEntries(files.map(f => [f.id, f])) : files
// Changes whenever any element is added, edited or deleted (Excalidraw bumps `version` on each edit).
export const sceneVersion = (els: readonly { version: number }[]): number =>
  els.reduce((sum, el) => sum + el.version, 0) * 1000 + els.length
