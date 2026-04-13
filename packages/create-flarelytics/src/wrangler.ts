import { execFile, spawn } from 'node:child_process';

interface ExecResult {
  ok: boolean;
  output: string;
  error?: string;
}

function exec(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: stdout.trim(), error: stderr || error.message });
      } else {
        resolve({ ok: true, output: stdout.trim() });
      }
    });
  });
}

export async function checkAuth(): Promise<{ authenticated: boolean; email?: string }> {
  const result = await exec('npx', ['wrangler', 'whoami']);
  if (!result.ok || result.output.includes('not authenticated')) {
    return { authenticated: false };
  }
  const emailMatch = result.output.match(/\S+@\S+\.\S+/);
  return { authenticated: true, email: emailMatch?.[0] };
}

export async function login(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'login'], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function deploy(cwd: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const result = await exec('npx', ['wrangler', 'deploy'], cwd);
  if (!result.ok) {
    return { ok: false, error: result.error || result.output };
  }
  // Extract worker URL from wrangler output
  const urlMatch = result.output.match(/https:\/\/[\w.-]+\.workers\.dev/);
  return { ok: true, url: urlMatch?.[0] };
}

export async function secretPut(name: string, value: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.stdin.write(value);
    child.stdin.end();

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        resolve({ ok: false, output: stdout.trim(), error: stderr.trim() });
      }
    });
    child.on('error', (err) => resolve({ ok: false, output: '', error: err.message }));
  });
}

export async function healthCheck(url: string): Promise<{ ok: boolean; status: number; body?: string }> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0 };
  }
}
