import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(),tailwindcss(),
  ],
  // during local development proxy ArcGIS hosts to avoid CORS issues
  server: {
    proxy: {
      // proxy Travis taxmaps requests
      '/proxy/taxmaps': {
        target: 'https://taxmaps.traviscountytx.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/proxy\/taxmaps/, ''),
      },
      // proxy Austin maps
      '/proxy/austin': {
        target: 'https://maps.austintexas.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/proxy\/austin/, ''),
      },
    }
  }
})
