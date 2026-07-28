import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./src/test/setup.js'],
    // jsdom + React Flow is memory intensive. Bounding workers prevents host
    // contention from turning normal async rendering into test timeouts.
    maxWorkers: 1,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
