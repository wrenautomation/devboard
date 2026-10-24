// A viewport change the server asked for (set_viewport): zoom to fit, centre on elements, or set zoom and scroll.
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { post } from './api'

export type ViewportRequest = {
  requestId: string
  scrollToContent?: boolean
  scrollToElementId?: string
  scrollToElementIds?: string[]
  viewportZoomFactor?: number
  zoom?: number
  offsetX?: number
  offsetY?: number
}

// `setView` applies a zoom/scroll change the way the caller wants (without starting a sync).
export async function applyViewport(
  api: ExcalidrawImperativeAPI,
  data: ViewportRequest,
  setView: (appState: Pick<AppState, 'zoom' | 'scrollX' | 'scrollY'>) => void,
): Promise<void> {
  try {
    if (data.scrollToContent) {
      const allElements = api.getSceneElements()
      if (allElements.length > 0) {
        api.scrollToContent(allElements, {
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
      const allElements = api.getSceneElements()
      const requestedIds = new Set(data.scrollToElementIds)
      const targetElements = allElements.filter(el => requestedIds.has(el.id))
      const foundIds = new Set(targetElements.map(el => el.id))
      const missingIds = data.scrollToElementIds.filter(id => !foundIds.has(id))
      if (missingIds.length > 0) {
        throw new Error(`Elements not found for IDs: ${missingIds.join(', ')}`)
      }
      api.scrollToContent(targetElements, {
        fitToViewport: true,
        viewportZoomFactor: data.viewportZoomFactor,
        animate: true,
      })
    } else if (data.scrollToElementId) {
      const allElements = api.getSceneElements()
      const targetElement = allElements.find(el => el.id === data.scrollToElementId)
      if (targetElement) {
        api.scrollToContent([targetElement], { fitToViewport: false, animate: true })
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
        setView(appState)
      }
    }

    await post('/api/viewport/result', {
      requestId: data.requestId,
      success: true,
      message: 'Viewport updated',
    })
  } catch (viewportError) {
    console.error('Viewport control failed:', viewportError)
    await post('/api/viewport/result', {
      requestId: data.requestId,
      error: (viewportError as Error).message,
    }).catch(() => {})
  }
}
