import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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

export default defineConfig({
  root: 'frontend',
  plugins: [react(), markerPen()],
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
