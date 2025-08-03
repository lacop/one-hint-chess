import { defineConfig } from 'vite'

export default defineConfig({
  base: '/one-hint-chess/',
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  },
  server: {
    port: 8000,
    host: '0.0.0.0', // Allow access from local network
  }
})