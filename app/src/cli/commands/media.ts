import * as fs from 'node:fs'
import { Readable } from 'node:stream'
import { batchCreateElementsStrict, getElementFromCanvas, updateElementOnCanvas } from '../../core/canvas-client.js'
import { EXPRESS_SERVER_URL } from '../../core/config.js'
import { prepareElement } from '../../core/normalize.js'
import { ensureCanvasRunning } from '../../core/spawn.js'
import type { ServerElement } from '../../types.js'
import { CliUsageError, parseArgs } from '../args.js'
import { printJson } from '../util.js'

// video: upload an mp4 to the media store (designs/2026-11-02-media.md), place it as a media embed.
// --id of an existing element: swap its video in place (same spot and width), so a re-shot film replaces the old
export async function video(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv, { width: { takesValue: true }, id: { takesValue: true } })
  const [file, xs, ys] = positionals
  if (!file) throw new CliUsageError('Usage: video <file.mp4> [x y] [--width 240] [--id <id>]')
  const size = fs.statSync(file).size
  await ensureCanvasRunning()

  // streamed: the file is never read into memory
  const res = await fetch(`${EXPRESS_SERVER_URL}/api/media`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
    body: Readable.toWeb(fs.createReadStream(file)) as ReadableStream,
    duplex: 'half',
  } as RequestInit)
  const meta = (await res.json()) as {
    success?: boolean
    error?: string
    src: string
    width: number
    height: number
    bytes: number
    reused: boolean
  }
  if (!res.ok || !meta.success) throw new Error(meta.error ?? `upload failed: HTTP ${res.status}`)

  const id = typeof flags.id === 'string' ? flags.id : undefined
  const old = id ? await getElementFromCanvas(id) : null
  const width = flags.width !== undefined ? Number(flags.width) : (old?.width ?? 240)
  const height = Math.round((width * meta.height) / Math.max(1, meta.width))
  if (old && id) {
    const at = xs !== undefined ? { x: Number(xs), y: Number(ys ?? old.y) } : {}
    await updateElementOnCanvas({ id, link: meta.src, width, height, ...at })
    return printJson({
      success: true,
      id,
      src: meta.src,
      bytes: meta.bytes,
      reused: meta.reused,
      width,
      height,
      replaced: true,
    })
  }
  const element = prepareElement({
    type: 'embeddable',
    x: Number(xs ?? 0),
    y: Number(ys ?? 0),
    width,
    height,
    link: meta.src,
    strokeWidth: 0,
    backgroundColor: 'transparent',
    roundness: { type: 3 },
    ...(id ? { id } : {}),
  } as never) as ServerElement
  const [created] = await batchCreateElementsStrict([element])
  printJson({ success: true, id: created?.id, src: meta.src, bytes: meta.bytes, reused: meta.reused, width, height })
}
