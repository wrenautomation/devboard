import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Local patch: whiteboard-marker pen. Excalidraw hard-codes its freehand options; make the line
// steadier (less pressure thinning) and smoother (more smoothing and streamline).
const markerPen = () => ({
  name: 'marker-pen',
  transform(code, id) {
    if (!id.includes('@excalidraw/excalidraw') || !/thinning:\s*(0)?\.6\b/.test(code)) return null
    const out = code.replace(/thinning:\s*0?\.6,(\s*)smoothing:\s*0?\.5,(\s*)streamline:\s*0?\.5/,
      'thinning: 0.12,$1smoothing: 0.7,$2streamline: 0.4')
    if (out === code) throw new Error('marker-pen: freehand options not found')
    return { code: out, map: null }
  },
})

// Local patch: the app opens with no network (the board comes from this browser's replica). The page
// is network first: Cloudflare Access must still see each open, or an expired login looks like an
// offline app. The code is precached; fonts cache on first use (the CJK sets are too big to precache).
// /api and the WebSocket never pass the worker.
const offlineShell = () => VitePWA({
  registerType: 'autoUpdate',
  manifest: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg}'],
    maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
    navigateFallback: null,
    cleanupOutdatedCaches: true,
    runtimeCaching: [
      {
        urlPattern: ({ request }) => request.mode === 'navigate',
        handler: 'NetworkFirst',
        options: { cacheName: 'pages', networkTimeoutSeconds: 4, precacheFallback: { fallbackURL: 'index.html' } },
      },
      {
        urlPattern: ({ url }) => url.pathname.endsWith('.woff2'),
        handler: 'CacheFirst',
        options: { cacheName: 'fonts', expiration: { maxEntries: 400 } },
      },
    ],
  },
})

export default defineConfig({
  root: 'frontend',
  plugins: [react(), markerPen(), offlineShell()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Excalidraw's font subsetting worker looks for these files by their
        // original (unhashed) names. Preserve them so the 404 doesn't break export.
        chunkFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith('subset-')) {
            return 'assets/[name].js'
          }
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
