import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  bundle: true,
  // Don't externalize dependencies — bundle everything for npx
  noExternal: [/@clack/, 'picocolors'],
});
