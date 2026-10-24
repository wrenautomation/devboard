// An image export the server asked for: Excalidraw's own exporter in this tab, the result posted back.
// Same option surface as the headless renderer (renderer:'node'), so `--renderer browser` accepts identical flags.
import { elementsOverlappingBBox, exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { postJson } from './api'

export interface ExportImageOptions {
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

export type ExportRequest = {
  requestId: string
  format?: 'png' | 'svg'
  background?: boolean
  options?: ExportImageOptions
}

// `ready`: the scene on screen is complete; an export of a half-loaded scene is refused, not rendered.
export async function exportForServer(
  api: ExcalidrawImperativeAPI,
  data: ExportRequest,
  ready: boolean,
): Promise<void> {
  const requestId = data.requestId
  // The server collects the tabs' results; a report that fails to send is not the export's problem.
  const report = (result: { format: 'png' | 'svg'; data: string } | { error: string }) =>
    postJson('/api/export/image/result', { requestId, ...result }).catch(() => {})
  try {
    if (!ready) throw new Error('Scene is not fully loaded; export is paused')
    // Same option surface as the headless renderer (renderer:'node'),
    // so `--renderer browser` accepts identical flags.
    const opts = data.options ?? {}
    const embedScene = opts.embedScene === true
    if (embedScene && data.format !== 'png') throw new Error('embedScene is only supported for PNG exports')
    const hide = new Set<string>(opts.hide ?? []) // scratch work never goes into an export for an agent
    const allElements = api.getSceneElements().filter(el => !hide.has(el.id))
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
    const appState = api.getAppState()
    const exportAppState = {
      ...appState,
      exportBackground: data.background !== false,
      exportEmbedScene: embedScene,
      ...(opts.dark !== undefined ? { exportWithDarkMode: opts.dark } : {}),
      exportScale: opts.scale ?? 1,
    }
    const files = api.getFiles()

    if (data.format === 'svg') {
      const svg = await exportToSvg({
        elements,
        appState: exportAppState,
        files,
        exportPadding: opts.padding,
        exportingFrame,
      })
      await report({ format: 'svg', data: new XMLSerializer().serializeToString(svg) })
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
          await report({ format: 'png', data: base64 })
        } catch (readerError) {
          console.error('Image export (FileReader) failed:', readerError)
          await report({ error: (readerError as Error).message })
        }
      }
      reader.onerror = async () => {
        console.error('FileReader error:', reader.error)
        await report({ error: reader.error?.message || 'FileReader failed' })
      }
      reader.readAsDataURL(blob)
    }
  } catch (exportError) {
    console.error('Image export failed:', exportError)
    await report({ error: (exportError as Error).message })
  }
}
