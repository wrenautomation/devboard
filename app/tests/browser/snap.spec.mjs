import { expect, test } from '@playwright/test'

// Hold the pen still at the end of a stroke: it snaps (frontend/src/Snap.tsx). The mouse stands in for the Pencil.

// The saved scene's strokes, once `ok` holds for them (the page saves on its own).
async function strokes(request, ok = l => l.length === 1) {
  let got = []
  await expect
    .poll(async () => {
      const { elements } = await (await request.get('/api/elements')).json()
      got = elements.filter(e => e.type === 'freedraw' && !e.isDeleted)
      return ok(got)
    })
    .toBe(true)
  return got
}

async function pen(page, request) {
  expect((await request.post('/api/elements/sync', { data: { elements: [] } })).ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  await page.getByTestId('toolbar-freedraw').click({ force: true })
  await expect(page.getByRole('radio', { name: 'Draw' })).toBeChecked()
}

// A path through the given screen points, with a wobble, as a hand draws.
async function draw(page, pts) {
  await page.mouse.move(pts[0][0], pts[0][1])
  await page.mouse.down()
  for (let i = 1; i < pts.length; i++)
    await page.mouse.move(pts[i][0] + ((i * 7) % 5) - 2, pts[i][1] + ((i * 11) % 5) - 2)
}

const scene = el => el.points.map(([x, y]) => [el.x + x, el.y + y])
// Largest distance of any point from the line through the first and last.
const bend = ps => {
  const [a, b] = [ps[0], ps.at(-1)]
  const l = Math.hypot(b[0] - a[0], b[1] - a[1])
  return Math.max(...ps.map(p => Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l))
}
const wobblyLine = Array.from({ length: 30 }, (_, i) => [300 + i * 12, 400 + Math.sin(i / 3) * 6])

test('a held stroke snaps to a straight line, and its end follows the pen until the lift', async ({
  page,
  request,
}) => {
  await pen(page, request)
  await draw(page, wobblyLine)
  await page.waitForTimeout(800)
  await page.mouse.move(660, 300, { steps: 6 })
  await page.mouse.up()
  const [line] = await strokes(request, l => l.length === 1 && bend(scene(l[0])) < 0.5)
  const ps = scene(line)
  expect(bend(ps)).toBeLessThan(0.5)
  expect(ps.length).toBeGreaterThan(10)
  // The pen lifted up and to the right of the stroke's end: the line turned up to follow it.
  const [a, b] = [ps[0], ps.at(-1)]
  expect(Math.atan2(b[1] - a[1], b[0] - a[0])).toBeLessThan(-0.2)
})

test('a stroke lifted without a hold stays as drawn', async ({ page, request }) => {
  await pen(page, request)
  await draw(page, wobblyLine)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const [raw] = await strokes(request)
  expect(bend(scene(raw))).toBeGreaterThan(3)
})

test('a held loop snaps to an ellipse; one undo takes the whole stroke', async ({ page, request }) => {
  await pen(page, request)
  const loop = Array.from({ length: 48 }, (_, i) => {
    const t = (2 * Math.PI * i) / 46
    return [500 + 120 * Math.cos(t), 400 + 80 * Math.sin(t)]
  })
  await draw(page, loop)
  await page.waitForTimeout(800)
  await page.mouse.up()
  const [ring] = await strokes(request, l => l.length === 1 && l[0].points.length > 60)
  const ps = scene(ring)
  const cx = ps.reduce((s, p) => s + p[0], 0) / ps.length,
    cy = ps.reduce((s, p) => s + p[1], 0) / ps.length
  const xs = ps.map(p => p[0]),
    ys = ps.map(p => p[1])
  const a = (Math.max(...xs) - Math.min(...xs)) / 2,
    b = (Math.max(...ys) - Math.min(...ys)) / 2
  const err = Math.max(...ps.map(p => Math.abs(Math.hypot((p[0] - cx) / a, (p[1] - cy) / b) - 1)))
  expect(err).toBeLessThan(0.03)
  await page.getByRole('button', { name: 'Undo' }).click()
  await strokes(request, l => l.length === 0)
})
