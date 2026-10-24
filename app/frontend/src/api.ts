// The canvas tab's one door to its server. Every request goes through here (biome restricts fetch elsewhere),
// so a header, a timeout or the error shape changes in one place.
import type { LibraryItem } from '@excalidraw/excalidraw/types'

// Marks the canvas tab: the server shows it scratch areas (agents get them hidden).
export const TAB = { 'x-devboard-tab': '1' }

type Headers = Record<string, string>
export type Reply<T> = { ok: boolean; status: number; data: T }

const JSON_HEADERS = { 'content-type': 'application/json' }
const parse = async <T>(r: Response): Promise<Reply<T>> => ({
  ok: r.ok,
  status: r.status,
  data: (await r.json().catch(() => ({}))) as T,
})
const failure = (reply: Reply<{ error?: string }>) => new Error(reply.data.error || `HTTP ${reply.status}`)

// GET and parse; throws on a refused answer (the body's error, else the status).
export async function fetchJson<T>(url: string, init: { headers?: Headers; timeoutMs?: number } = {}): Promise<T> {
  const reply = await parse<T & { error?: string }>(
    await fetch(url, {
      headers: init.headers,
      signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
    }),
  )
  if (!reply.ok) throw failure(reply)
  return reply.data
}

// GET and parse; null when the server is away or refuses.
export const getJson = <T>(url: string): Promise<T | null> => fetchJson<T>(url).catch(() => null)

// POST JSON; the parsed reply with its status, for callers that branch on it (a 409 on push).
export async function post<T>(url: string, body: unknown, headers: Headers = {}): Promise<Reply<T>> {
  return parse<T>(
    await fetch(url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }),
  )
}

// POST JSON; throws on a refused answer or `success: false`.
export async function postJson<T>(url: string, body: unknown, headers: Headers = {}): Promise<T> {
  const reply = await post<T & { success?: boolean; error?: string }>(url, body, headers)
  if (!reply.ok || reply.data.success === false) throw failure(reply)
  return reply.data
}

// POST raw bytes (a thumbnail).
export async function postBinary(url: string, body: Blob, headers: Headers): Promise<void> {
  await fetch(url, { method: 'POST', headers: { 'content-type': body.type, ...headers }, body })
}

// The canvas's own library pack (/lib/wren.excalidrawlib): brand logos, system design, stickies.
// Each item carries a category and search tags on top of Excalidraw's library item.
export type PackItem = LibraryItem & { name: string; category: string; tags?: string }
let packPromise: Promise<PackItem[]> | null = null
export const loadPack = (): Promise<PackItem[]> =>
  (packPromise ??= fetchJson<{ libraryItems?: PackItem[] }>('/lib/wren.excalidrawlib')
    .then(d => d.libraryItems ?? [])
    .catch(() => {
      packPromise = null
      return []
    }))
