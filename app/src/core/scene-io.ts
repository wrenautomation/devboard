import fs from 'node:fs'
import { type ExcalidrawFile, generateId, type ServerElement } from '../types.js'
import {
  batchCreateElementsOnCanvas,
  getElements,
  getFiles,
  isDurableCanvasStateEnabled,
  postFiles,
  replaceElementsOnCanvas,
} from './canvas-client.js'
import { expandElementsForExport } from './expand-elements.js'
import { sanitizeFilePath } from './normalize.js'
import { decodeSceneInput } from './scene-input.js'

// A .excalidraw file: what the canvas writes and reads back (Excalidraw's own format, elements expanded).
export interface SceneFile {
  type?: string
  version?: number
  source?: string
  elements: ServerElement[]
  appState?: { viewBackgroundColor?: string; gridSize?: number | null; [key: string]: unknown }
  files?: Record<string, ExcalidrawFile>
}

export interface ExportedScene {
  scene: SceneFile
  elementCount: number
}

// Parsed scene JSON as a SceneFile: a bare element array is a scene with only elements.
export function sceneFromJson(json: unknown): SceneFile {
  if (Array.isArray(json)) return { elements: json as ServerElement[] }
  const scene = (json ?? {}) as Partial<SceneFile>
  return { ...scene, elements: Array.isArray(scene.elements) ? scene.elements : [] }
}

// Build a .excalidraw scene JSON from the current canvas state.
// Elements are expanded from the agent format (label/start/end) into real
// Excalidraw elements (bound text pairs, arrow bindings) so the file renders
// fully on excalidraw.com and in the Obsidian Excalidraw plugin — with
// deterministic ids/seeds so re-exporting an unchanged scene is byte-stable.
export async function buildSceneFile(): Promise<ExportedScene> {
  const sceneElements = await getElements()
  const exportElements = expandElementsForExport(sceneElements, { deterministic: true })

  // Fetch files for image elements
  let sceneFiles: Record<string, ExcalidrawFile> = {}
  try {
    sceneFiles = await getFiles()
  } catch {
    /* files endpoint may not exist */
  }

  const excalidrawScene: SceneFile = {
    type: 'excalidraw',
    version: 2,
    source: 'mcp-excalidraw-server',
    elements: exportElements,
    appState: {
      viewBackgroundColor: '#ffffff',
      gridSize: null,
    },
    ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {}),
  }

  return { scene: excalidrawScene, elementCount: exportElements.length }
}

export interface ImportResult {
  count: number
  fileCount: number
  mode: 'replace' | 'merge'
}

// Import elements from .excalidraw JSON, Obsidian .excalidraw.md, an embedded
// PNG scene, or raw JSON data.
export async function importScene(options: {
  filePath?: string
  data?: string
  mode: 'replace' | 'merge'
}): Promise<ImportResult> {
  let input: Buffer | string
  if (options.filePath) {
    const safeImportPath = sanitizeFilePath(options.filePath)
    input = fs.readFileSync(safeImportPath)
  } else if (options.data) {
    input = options.data
  } else {
    throw new Error('Either filePath or data must be provided')
  }
  const sceneData = sceneFromJson(JSON.parse(decodeSceneInput(input)))
  const importElements = sceneData.elements

  if (importElements.length === 0) {
    throw new Error('No elements found in the import data')
  }

  // Batch create the imported elements
  const elementsToCreate = importElements.map(el => ({
    ...el,
    id: el.id || generateId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  }))

  let importedFileCount = 0
  const importFiles = sceneData.files
  const fileList: ExcalidrawFile[] = importFiles && typeof importFiles === 'object' ? Object.values(importFiles) : []
  const durableStateEnabled = fileList.length > 0 ? await isDurableCanvasStateEnabled() : false

  if (durableStateEnabled) {
    // A durable checkpoint cannot reference an image until its immutable blob
    // is published. File failure therefore aborts before touching elements.
    await postFiles(fileList)
    importedFileCount = fileList.length
  }

  const created =
    options.mode === 'replace'
      ? await replaceElementsOnCanvas(elementsToCreate)
      : await batchCreateElementsOnCanvas(elementsToCreate)
  if (!created) {
    throw new Error('Import failed: canvas rejected the batch create')
  }

  if (!durableStateEnabled && fileList.length > 0) {
    // Keep the original in-memory contract: elements are accepted first and
    // file import remains best effort when persistence is disabled.
    try {
      await postFiles(fileList)
      importedFileCount = fileList.length
    } catch {
      /* best effort */
    }
  }

  return { count: elementsToCreate.length, fileCount: importedFileCount, mode: options.mode }
}
