import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// A throwaway boards folder, as agent.mjs lays out: the page waits for a board before it draws.
const boards = mkdtempSync(join(tmpdir(), 'devboard-test-'))
mkdirSync(join(boards, 'projects', 'main'), { recursive: true })
writeFileSync(join(boards, 'current'), 'main')

// Never attach these destructive fixture tests to an existing user's canvas.
const port = Number(process.env.CANVAS_TEST_PORT || 51910)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node dist/server.js',
    env: {
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'error',
      EXCALIDRAW_PROJECTS_DIR: join(boards, 'projects'),
      EXCALIDRAW_CURRENT_FILE: join(boards, 'current'),
      EXCALIDRAW_DATA_DIR: join(boards, 'projects', 'main'),
    },
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 15000,
  },
})
