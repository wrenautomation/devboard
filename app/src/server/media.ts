import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import express, { type Express, type Request, type Response } from 'express'
import logger from '../logger.js'
import type { ExcalidrawFile, ServerElement } from '../types.js'
import { PROJECTS_DIR } from './boards.js'
import { fail } from './reply.js'

// Local patch: videos on the canvas. Design: designs/2026-11-02-media.md.
// Content-addressed: <sha256 of output>.mp4 + .jpg poster + .json meta; src/<source sha> aliases skip re-encodes.

const run = promisify(execFile)
const MAX_BYTES = 1 << 30
export const MEDIA_LINK = /^\/media\/([0-9a-f]{64})\.mp4$/

export const mediaDir = (): string | null =>
  process.env.EXCALIDRAW_MEDIA_DIR || (PROJECTS_DIR ? path.join(PROJECTS_DIR, '.media') : null)

export interface MediaMeta {
  sha: string
  src: string
  poster: string
  width: number
  height: number
  duration: number
  bytes: number
}

// one ffmpeg at a time
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job)
  queue = next.catch(() => {})
  return next
}

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

const readMeta = (dir: string, sha: string): MediaMeta | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${sha}.json`), 'utf8')) as MediaMeta
  } catch {
    return null
  }
}

async function ingest(dir: string, source: string, sourceSha: string): Promise<MediaMeta & { reused: boolean }> {
  const alias = path.join(dir, 'src', sourceSha)
  const known = fs.existsSync(alias) ? readMeta(dir, fs.readFileSync(alias, 'utf8').trim()) : null
  if (known) return { ...known, reused: true }

  const tmp = path.join(dir, `.tmp-${randomUUID()}.mp4`)
  try {
    // bitexact + no metadata: same source, same ffmpeg = same bytes
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale='min(720,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags',
      '+bitexact',
      '-movflags',
      '+faststart',
      tmp,
    ])
    const sha = await sha256File(tmp)
    const mp4 = path.join(dir, `${sha}.mp4`)
    let meta = readMeta(dir, sha)
    if (meta) fs.rmSync(tmp)
    else {
      fs.renameSync(tmp, mp4)
      await run('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-sseof',
        '-0.3',
        '-i',
        mp4,
        '-frames:v',
        '1',
        '-q:v',
        '4',
        path.join(dir, `${sha}.jpg`),
      ])
      const { stdout } = await run('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        mp4,
      ])
      const probe = JSON.parse(stdout) as { streams: { width: number; height: number }[]; format: { duration: string } }
      meta = {
        sha,
        src: `/media/${sha}.mp4`,
        poster: `/media/${sha}.jpg`,
        width: probe.streams[0]?.width ?? 0,
        height: probe.streams[0]?.height ?? 0,
        duration: Number(probe.format.duration) || 0,
        bytes: fs.statSync(mp4).size,
      }
      // meta last: its presence marks a complete entry
      fs.writeFileSync(path.join(dir, `${sha}.json`), `${JSON.stringify(meta)}\n`)
    }
    fs.mkdirSync(path.dirname(alias), { recursive: true })
    fs.writeFileSync(alias, `${sha}\n`)
    return { ...meta, reused: false }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export function mountMedia(app: Express): void {
  const dir = mediaDir()
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })

  // names never change bytes: cache forever; Range for seeking and streaming
  app.use('/media', express.static(dir, { immutable: true, maxAge: '365d', index: false }))

  // raw bytes in; streamed to disk while hashed, never held in memory
  app.post('/api/media', async (req: Request, res: Response) => {
    const declared = Number(req.headers['content-length'])
    if (declared > MAX_BYTES) return fail(res, 413, 'video over 1 GB')
    const upload = path.join(dir, `.tmp-${randomUUID()}.in`)
    const hash = createHash('sha256')
    let size = 0
    try {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        hash.update(chunk)
        if (size > MAX_BYTES) req.destroy(new Error('video over 1 GB'))
      })
      await pipeline(req, fs.createWriteStream(upload))
      if (size === 0) return fail(res, 400, 'empty body')
      const meta = await serial(() => ingest(dir, upload, hash.digest('hex')))
      res.json({ success: true, ...meta })
    } catch (error) {
      logger.error('Media upload failed:', error)
      fail(res, 400, (error as Error).message)
    } finally {
      fs.rmSync(upload, { force: true })
    }
  })
}

// headless render: each media embed drawn as its poster image
export function withPosters(
  sceneElements: ServerElement[],
  sceneFiles: Record<string, ExcalidrawFile>,
): { elements: ServerElement[]; files: Record<string, ExcalidrawFile> } {
  const dir = mediaDir()
  if (!dir) return { elements: sceneElements, files: sceneFiles }
  const files = { ...sceneFiles }
  const elements = sceneElements.map(el => {
    const sha = (el.type as string) === 'embeddable' ? MEDIA_LINK.exec(el.link ?? '')?.[1] : undefined
    if (!sha) return el
    const fileId = `media-${sha}`
    if (!files[fileId]) {
      try {
        const jpg = fs.readFileSync(path.join(dir, `${sha}.jpg`))
        files[fileId] = {
          id: fileId,
          dataURL: `data:image/jpeg;base64,${jpg.toString('base64')}`,
          mimeType: 'image/jpeg',
          created: 0,
        }
      } catch {
        return el
      }
    }
    return { ...el, type: 'image', fileId, status: 'saved', scale: [1, 1] } as ServerElement
  })
  return { elements, files }
}
