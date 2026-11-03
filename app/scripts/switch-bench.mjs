#!/usr/bin/env node
// Board switch timing on an emulated iPad (Chromium, 4x CPU, 60 ms, 20 Mbps).
// Own server on :3199 over a temp projects dir; never the live canvas.
// Run after `npm run build`: node scripts/switch-bench.mjs [Big,Mid,Big,Small]
// Times count from the click event: switch mark, scene marks (App.tsx), long tasks.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const PORT = '3199'
const U = `http://127.0.0.1:${PORT}`
const seq = (process.argv[2] ?? 'Big,Mid,Big,Small,Mid,Big').split(',')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devboard-bench-'))
fs.mkdirSync(path.join(dir, 'projects', 'main'), { recursive: true })
Object.assign(process.env, {
  HOST: '127.0.0.1',
  PORT,
  EXCALIDRAW_PROJECTS_DIR: path.join(dir, 'projects'),
  EXCALIDRAW_CURRENT_FILE: path.join(dir, 'current'),
  EXCALIDRAW_DATA_DIR: path.join(dir, 'projects', 'main'),
})
const { startServer } = await import('../dist/server.js')
await startServer()

const post = async (p, body, headers = {}) => {
  const r = await fetch(U + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${p} ${r.status} ${(await r.text()).slice(0, 200)}`)
}
const seed = async (name, els) => {
  await post('/api/projects/open', { name })
  for (let i = 0; i < els.length; i += 200)
    await post('/api/elements/batch', { elements: els.slice(i, i + 200) }, { 'x-canvas-project': name })
}
const rects = (n, cols) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'rectangle',
    x: (i % cols) * 220,
    y: Math.floor(i / cols) * 140,
    width: 180,
    height: 90,
    label: { text: `Box ${i} with a longer label` },
  }))
const pens = n =>
  Array.from({ length: n }, (_, i) => ({
    type: 'freedraw',
    x: (i % 30) * 140,
    y: 3000 + Math.floor(i / 30) * 60,
    width: 120,
    height: 24,
    points: Array.from({ length: 40 }, (_, k) => [k * 3, Math.sin(k / 4 + i) * 12]),
  }))
await seed('Big', [...rects(300, 20), ...pens(1000)])
await seed('Mid', rects(170, 10))
await seed('Small', rects(40, 8))

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: 2.5e6,
    uploadThroughput: 2.5e6,
  })
  await page.addInitScript(() => {
    window.__long = []
    window.__clicks = []
    addEventListener('click', () => window.__clicks.push(performance.now()), true)
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration])
    }).observe({
      type: 'longtask',
      buffered: true,
    })
  })
  await page.goto(U)
  await page.waitForFunction(() => performance.getEntriesByName('devboard:scene').length > 0, null, { timeout: 60000 })
  await page.waitForTimeout(9000) // preload window

  for (const board of seq) {
    await page.locator('button.pj-crumb').click()
    const card = page
      .locator('.pj-card', { hasText: new RegExp(`^${board}`) })
      .locator('.pj-hit')
      .first()
    await card.waitFor()
    const before = await page.evaluate(() => performance.now())
    await card.click()
    await page.waitForSelector('.pj-sheet', { state: 'detached', timeout: 30000 })
    // settle: no new long task for 1.5 s
    for (let last = -1; ; ) {
      await page.waitForTimeout(500)
      const n = await page.evaluate(() => window.__long.length)
      if (n === last) break
      last = n
      await page.waitForTimeout(1000)
    }
    const r = await page.evaluate(
      ([before, board]) => {
        const t0 = window.__clicks.find(c => c > before) ?? before
        const ms = t => Math.round(t - t0)
        const sw = performance.getEntriesByName('devboard:switch').find(m => m.startTime >= t0)
        const marks = performance
          .getEntriesByName('devboard:scene')
          .filter(m => m.startTime > t0 && m.detail?.board === board)
          .map(m => ms(m.startTime))
        const long = window.__long.filter(([s]) => s > t0).map(([, d]) => d)
        return {
          sw: sw ? ms(sw.startTime) : null,
          marks,
          blocked: Math.round(long.reduce((a, d) => a + d, 0)),
          max: Math.round(Math.max(0, ...long)),
        }
      },
      [before, board],
    )
    console.log(
      `${board.padEnd(6)} switch ${r.sw ?? '-'} ms  first scene ${r.marks[0] ?? '-'} ms  last ${r.marks.at(-1) ?? '-'} ms  scenes ${r.marks.length}  blocked ${r.blocked} ms (max ${r.max})`,
    )
  }
} finally {
  await browser.close()
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
