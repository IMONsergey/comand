import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const hubOrigin = 'http://127.0.0.1:4310';
const developmentOrigins = new Set([
  'http://127.0.0.1:4311',
  'http://localhost:4311',
  'http://[::1]:4311',
]);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: hubOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Trust only a browser request from this loopback development server.
            // Keep foreign/missing Origins intact so the hub still rejects them.
            const origin = req.headers.origin;
            if (
              origin &&
              developmentOrigins.has(origin) &&
              origin === `http://${req.headers.host}`
            ) {
              proxyReq.setHeader('Origin', hubOrigin);
            }
          });
        },
      },
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: false, sourcemap: true },
});
