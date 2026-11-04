// Edits our own buttons make outside Excalidraw's tools. They bump the version the way Excalidraw does, so
// sync (the higher version wins) and the Mac's tie-break (the lower nonce) treat them as edits.
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export const nonce = () => Math.floor(Math.random() * 2 ** 31)

export const edited = <T extends ExcalidrawElement>(e: T, patch: Partial<T>): T => ({
  ...e,
  ...patch,
  version: e.version + 1,
  versionNonce: nonce(),
  updated: Date.now(),
})

// A style on the selected shapes (and the text bound in them, as Excalidraw does) and on the defaults for new ones.
// `patch` null: app state only. EVENTUALLY = live preview: same version, so not synced or committed. A bumped
// version there would break undo: an IMMEDIATELY updateScene resets elements with uncommitted versions to their
// committed copy (Store.filterUncomittedElements), the step holds no visible change, and undo skips past it.
export function restyle(
  api: ExcalidrawImperativeAPI,
  appState: Partial<AppState>,
  patch: Partial<ExcalidrawElement> | null,
  capture: 'EVENTUALLY' | 'IMMEDIATELY' = 'IMMEDIATELY',
) {
  const picked = api.getAppState().selectedElementIds
  const hit = (e: ExcalidrawElement) =>
    !e.isDeleted && (picked[e.id] || ('containerId' in e && e.containerId !== null && picked[e.containerId]))
  api.updateScene({
    appState: appState as AppState,
    ...(patch && {
      elements: api
        .getSceneElementsIncludingDeleted()
        .map(e =>
          !hit(e) ? e : capture === 'IMMEDIATELY' ? edited(e, patch) : ({ ...e, ...patch } as ExcalidrawElement),
        ),
    }),
    captureUpdate: CaptureUpdateAction[capture],
  })
}
