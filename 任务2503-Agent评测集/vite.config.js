/**
 * Optional demo scaffold only.
 *
 * The core deliverable (agent runtime, evaluation runner and reports) is plain
 * Node.js and needs no bundler. This config is kept for a buyer who later wants
 * to attach a React 18 + Vite 6 dashboard; no demo source is shipped in this
 * package so that the delivered file list stays exactly as requested.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
  build: { outDir: 'dist' },
});
