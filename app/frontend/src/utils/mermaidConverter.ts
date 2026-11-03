import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles, ExcalidrawImperativeAPI, SceneData } from '@excalidraw/excalidraw/types'
import { type MermaidConfig, parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'

export interface MermaidConversionResult {
  elements: readonly ExcalidrawElement[]
  files?: BinaryFiles
  error?: string
}

/**
 * Converts a Mermaid diagram definition to Excalidraw elements
 * This function needs to run in the browser context as it requires DOM access
 */
export const convertMermaidToExcalidraw = async (
  mermaidDefinition: string,
  config?: MermaidConfig,
): Promise<MermaidConversionResult> => {
  try {
    // Parse the Mermaid diagram to Excalidraw elements
    const result = await parseMermaidToExcalidraw(mermaidDefinition, config)

    return {
      elements: result.elements,
      files: result.files,
    }
  } catch (error) {
    console.error('Error converting Mermaid to Excalidraw:', error)
    return {
      elements: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Default Mermaid configuration for Excalidraw conversion
 */
export const DEFAULT_MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  flowchart: {
    curve: 'linear',
  },
  themeVariables: {
    fontSize: '20px',
  },
  maxEdges: 500,
  maxTextSize: 50000,
}

// mermaid_convert from the server: merge onto the scene (updateScene replaces the list; a sync would push the
// wipe). `apply` updates the scene without a sync; `live` is false once the scene changed under the convert.
// Returns the element count added.
export const importMermaid = async (
  api: ExcalidrawImperativeAPI,
  diagram: string,
  config: MermaidConfig | undefined,
  apply: (scene: { elements: readonly ExcalidrawElement[]; captureUpdate: SceneData['captureUpdate'] }) => void,
  live: () => boolean,
): Promise<number> => {
  const result = await convertMermaidToExcalidraw(diagram, config || DEFAULT_MERMAID_CONFIG)
  if (!live()) return 0
  if (result.error) throw new Error(result.error)
  if (!result.elements.length) return 0
  // fresh ids: mermaid emits stable ids ("A", "B"), so a repeat convert would collide
  const converted = convertToExcalidrawElements(
    [...result.elements] as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: true },
  )
  apply({ elements: [...api.getSceneElements(), ...converted], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  if (result.files) api.addFiles(Object.values(result.files))
  return result.elements.length
}
