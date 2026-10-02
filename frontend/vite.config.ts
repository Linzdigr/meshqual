import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The dev server proxies the API so the browser sees one origin: no CORS,
    // and the SSE stream is not a cross-origin EventSource.
    proxy: {
      '/api': {
        target: process.env.MESHQUAL_API_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        ws: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // MapLibre is most of the bundle and changes far less often than the app.
        // Splitting it keeps the app chunk small and cacheable on its own.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          primevue: ['primevue/datatable', 'primevue/column', 'primevue/config'],
        },
      },
    },
  },
})
