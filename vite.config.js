import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';

export default defineConfig({
  server: { port: 5210, strictPort: false, open: false },
  build: { target: 'es2022', outDir: 'dist' },
  plugins: [{
    name: 'copy-runtime-assets',
    closeBundle() {
      cpSync(new URL('./assets', import.meta.url), new URL('./dist/assets', import.meta.url), { recursive: true });
    }
  }]
});
