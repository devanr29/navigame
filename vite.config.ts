import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Developer mode lives at /developer. The dev and preview servers already answer it with index.html;
 * a copy in the build makes it work on plain static hosts too.
 */
function developerPage(): Plugin {
  let outDir = 'dist';
  return {
    name: 'developer-page',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      mkdirSync(resolve(outDir, 'developer'), { recursive: true });
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, 'developer/index.html'));
    },
  };
}

export default defineConfig({
  // host: true exposes the dev server on the local network so a phone on the same Wi-Fi can open it.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  worker: { format: 'es' },
  plugins: [developerPage()],
});
