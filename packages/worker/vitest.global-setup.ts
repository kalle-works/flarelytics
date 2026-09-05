// Runs once before the worker's test suite. src/tracker-script.ts imports
// the tracker package's generated dist/tracker-script.mjs; under turbo, `test`
// depends on `build`, which depends on `^build` (the tracker's build runs
// first). Invoked directly — `npx vitest run`, bypassing turbo — nothing
// guarantees that ordering, so build the tracker here if the artifact is
// missing rather than failing with a confusing "module not found".
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export default function setup(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const trackerDir = resolve(__dirname, '../tracker');
  const artifact = resolve(trackerDir, 'dist/tracker-script.mjs');

  if (!existsSync(artifact)) {
    console.log('[vitest] packages/tracker/dist/tracker-script.mjs is missing — building @flarelytics/tracker first.');
    execSync('npm run build', { cwd: trackerDir, stdio: 'inherit' });
  }
}
