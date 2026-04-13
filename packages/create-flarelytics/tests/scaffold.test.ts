import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WORKER_SOURCE = '// mock worker source\nexport default { fetch() { return new Response("ok"); } };';

describe('scaffold', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flarelytics-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = {
    accountId: 'abc123def456abc123def456abc123de',
    datasetName: 'test-site',
    allowedOrigins: 'https://example.com',
  };

  it('creates all required files', async () => {
    const targetDir = join(tempDir, 'project');
    const result = await scaffold(targetDir, config, WORKER_SOURCE);

    expect(result.files).toContain('wrangler.toml');
    expect(result.files).toContain('package.json');
    expect(result.files).toContain('tsconfig.json');
    expect(result.files).toContain(join('src', 'index.ts'));
  });

  it('writes wrangler.toml with correct config', async () => {
    const targetDir = join(tempDir, 'project');
    await scaffold(targetDir, config, WORKER_SOURCE);

    const content = await readFile(join(targetDir, 'wrangler.toml'), 'utf-8');
    expect(content).toContain(config.accountId);
    expect(content).toContain(config.datasetName);
    expect(content).toContain(config.allowedOrigins);
  });

  it('writes worker source to src/index.ts', async () => {
    const targetDir = join(tempDir, 'project');
    await scaffold(targetDir, config, WORKER_SOURCE);

    const content = await readFile(join(targetDir, 'src', 'index.ts'), 'utf-8');
    expect(content).toBe(WORKER_SOURCE);
  });

  it('creates src directory', async () => {
    const targetDir = join(tempDir, 'project');
    await scaffold(targetDir, config, WORKER_SOURCE);

    const entries = await readdir(join(targetDir, 'src'));
    expect(entries).toContain('index.ts');
  });

  it('throws if directory is not empty', async () => {
    const targetDir = join(tempDir, 'nonempty');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'existing.txt'), 'data');

    await expect(scaffold(targetDir, config, WORKER_SOURCE))
      .rejects.toThrow('not empty');
  });

  it('succeeds with empty existing directory', async () => {
    const targetDir = join(tempDir, 'empty');
    await mkdir(targetDir, { recursive: true });

    const result = await scaffold(targetDir, config, WORKER_SOURCE);
    expect(result.files.length).toBe(4);
  });
});
