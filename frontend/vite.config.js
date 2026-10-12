import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8011,   // port fixe (8000/8001 = Claude Trading)
    strictPort: true  // échoue si le port est déjà utilisé
  }
})
