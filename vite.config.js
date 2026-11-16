import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// API_PROXY=http://127.0.0.1:8794 sends /api to a local stand while developing.
export default defineConfig({
  plugins: [react()],
  server: process.env.API_PROXY ? { proxy: { '/api': process.env.API_PROXY } } : undefined,
})
