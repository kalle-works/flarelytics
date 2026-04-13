import { execFile } from 'node:child_process';

function exec(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: stderr || error.message });
      } else {
        resolve({ ok: true, output: stdout.trim() });
      }
    });
  });
}

export function checkNodeVersion(): { ok: boolean; version: string } {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  return { ok: major >= 22, version };
}

export async function checkWrangler(): Promise<{ ok: boolean; version: string }> {
  const result = await exec('npx', ['wrangler', '--version']);
  return { ok: result.ok, version: result.output };
}
