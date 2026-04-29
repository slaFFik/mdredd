import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', {}]],
      },
    }),
  ],
  root: resolve(__dirname, 'src/web'),
  publicDir: false,
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Rewrite Origin + Host before forwarding so the mdredd server's strict
      // same-origin pin sees its own URL, not Vite's. Without this, fetches
      // from the SPA (running on :5173) would arrive at :6800 with
      // Origin: http://127.0.0.1:5173 and get 403'd. BOTH lines below are
      // load-bearing: `changeOrigin: true` rewrites Host to the target's
      // value (covers the host check), and the explicit `headers.Origin`
      // override rewrites the Origin header (covers the origin check).
      // Removing either re-breaks dev mode.
      '/api': {
        target: 'http://127.0.0.1:6800',
        changeOrigin: true,
        headers: { Origin: 'http://127.0.0.1:6800' },
      },
      '/sse': {
        target: 'http://127.0.0.1:6800',
        changeOrigin: true,
        headers: { Origin: 'http://127.0.0.1:6800' },
      },
    },
  },
});
