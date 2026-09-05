import { defineConfig, type Plugin } from 'vitest/config';
import { readFileSync } from 'node:fs';

// src/tracker-script.ts imports the tracker package's built .iife.js as a
// default-exported string (matching wrangler's `[[rules]] type = "Text"`
// module rule used at deploy time — see wrangler.toml.example). Vite/vitest
// have no built-in "import a .js file as text" mode, so read the file
// ourselves and hand back a tiny module that default-exports its contents.
function rawTextModule(): Plugin {
  return {
    name: 'flarelytics-raw-text-modules',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.iife.js')) return null;
      const filePath = id.split('?')[0];
      const source = readFileSync(filePath, 'utf-8');
      return `export default ${JSON.stringify(source)};`;
    },
  };
}

export default defineConfig({
  plugins: [rawTextModule()],
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
