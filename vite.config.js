import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WEB_PORT } from './src/config.js';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  server: { port: WEB_PORT, strictPort: false },
  build: { outDir: '../../dist-web', emptyOutDir: true },
});
