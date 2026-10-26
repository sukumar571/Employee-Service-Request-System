import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Vite configuration.
 *
 * Development: the SPA runs on :5173 and proxies `/api` to the Express API on :4000, so the
 * browser never needs a cross-origin call locally (docs/system-architecture.md §6).
 * Production: `vite build` emits static assets served by nginx, which proxies `/api` same-origin.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = env.VITE_DEV_API_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { port: 4173, strictPort: true },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      // One vendor chunk keeps the demo simple; split further when the bundle grows (Phase 18).
      chunkSizeWarningLimit: 600,
    },
  };
});
