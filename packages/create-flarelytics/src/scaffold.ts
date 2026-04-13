import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateWranglerToml, generatePackageJson, generateTsconfig, type WorkerConfig } from './templates.js';

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

export async function scaffold(
  targetDir: string,
  config: WorkerConfig,
  workerSource: string,
): Promise<ScaffoldResult> {
  // Check if directory exists and is non-empty
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`Directory "${targetDir}" is not empty`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  await mkdir(join(targetDir, 'src'), { recursive: true });

  const files: Array<{ path: string; content: string }> = [
    { path: 'wrangler.toml', content: generateWranglerToml(config) },
    { path: 'package.json', content: generatePackageJson(config.datasetName) },
    { path: 'tsconfig.json', content: generateTsconfig() },
    { path: join('src', 'index.ts'), content: workerSource },
  ];

  const written: string[] = [];
  for (const file of files) {
    const fullPath = join(targetDir, file.path);
    await writeFile(fullPath, file.content, 'utf-8');
    written.push(file.path);
  }

  return { dir: targetDir, files: written };
}
