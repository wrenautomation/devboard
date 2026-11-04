import { expect, test } from '@playwright/test'

// Color rows (frontend/src/Colors.tsx): quick picks and the system color picker, for stroke, background and canvas.

async function open(page, request) {
  expect((await request.post('/api/elements/sync', { data: { elements: [] } })).ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
}

async function saved(request, ok) {
  let got = []
  await expect
    .poll(async () => {
      const { elements } = await (await request.get('/api/elements')).json()
      got = elements.filter(e => !e.isDeleted)
      return ok(got)
    })
    .toBe(true)
  return got
}

const row = (page, n) => page.locator('.selected-shape-actions .cp-row').nth(n)

test('each style row is one line: six picks, purple among them, and the custom swatch', async ({ page, request }) => {
  await open(page, request)
  await page.getByTestId('toolbar-freedraw').click({ force: true })
  await expect(page.locator('.selected-shape-actions .color-picker-container').first()).toBeHidden()
  for (const n of [0, 1]) {
    await expect(row(page, n).locator('button')).toHaveCount(6)
    await expect(row(page, n).locator('input[type=color]')).toHaveCount(1)
    expect((await row(page, n).boundingBox()).height).toBeLessThanOrEqual(36)
  }
  await expect(row(page, 0).getByRole('button', { name: '#9c36b5' })).toBeVisible()
})

test('a pick sets the pen; width and custom color set the selection, and one undo takes back the color', async ({
  page,
  request,
}) => {
  await open(page, request)
  await page.getByTestId('toolbar-freedraw').click({ force: true })
  await row(page, 0).getByRole('button', { name: '#9c36b5' }).click()
  await page.mouse.move(300, 300)
  await page.mouse.down()
  await page.mouse.move(400, 360, { steps: 8 })
  await page.mouse.up()
  await saved(request, l => l.length === 1 && l[0].strokeColor === '#9c36b5')

  await page.getByTestId('toolbar-rectangle').click({ force: true })
  await page.mouse.move(500, 300)
  await page.mouse.down()
  await page.mouse.move(650, 420, { steps: 6 })
  await page.mouse.up()
  // The width row shares the same edit path (StrokeWidth.tsx).
  await page.getByRole('button', { name: 'Heavy' }).click()
  await saved(request, l => l.some(e => e.type === 'rectangle' && e.strokeWidth === 4))
  await row(page, 0).locator('input[type=color]').fill('#123456')
  await saved(request, l => l.some(e => e.type === 'rectangle' && e.strokeColor === '#123456'))
  await expect(row(page, 0).locator('.cp-custom')).toHaveClass(/active/)
  await page.getByRole('button', { name: 'Undo' }).click()
  await saved(request, l => l.some(e => e.type === 'rectangle' && e.strokeColor === '#9c36b5'))
})

test('the canvas background row in the menu has the custom swatch', async ({ page, request }) => {
  await open(page, request)
  await page.getByTestId('main-menu-trigger').click()
  const custom = page.locator('.cp-row input[type=color]')
  await expect(custom).toHaveCount(1)
  await custom.fill('#202833')
  await expect(page.locator('.cp-row .cp-custom.active')).toHaveCount(1)
  await expect.poll(() => page.locator('.cp-row input[type=color]').inputValue()).toBe('#202833')
})
