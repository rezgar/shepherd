import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built bundle also loads over file:// inside the
  // packaged Electron app (not just from a web server at '/').
  base: './',
  server: { port: 5173 },
});
