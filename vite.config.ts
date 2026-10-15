import { defineConfig } from 'vite';

export default defineConfig({
  // host: true exposes the dev server on the local network so a phone on the same Wi-Fi can open it.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  worker: { format: 'es' },
});
