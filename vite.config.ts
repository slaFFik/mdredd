import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/web'),
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:6800',
      '/sse': 'http://127.0.0.1:6800',
    },
  },
});
