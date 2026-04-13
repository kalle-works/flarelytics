import * as p from '@clack/prompts';
import pc from 'picocolors';
import { generateApiKey } from './crypto.js';
import { checkNodeVersion, checkWrangler } from './prerequisites.js';
import { validateToken, validateAccount } from './cloudflare.js';
import * as wrangler from './wrangler.js';
import { scaffold } from './scaffold.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getWorkerSource(): Promise<string> {
  // In development: read from templates directory
  // When bundled: the file is adjacent to dist/
  const paths = [
    resolve(__dirname, '..', 'templates', 'worker-source.ts'),
    resolve(__dirname, 'worker-source.ts'),
  ];
  for (const p of paths) {
    try {
      return await readFile(p, 'utf-8');
    } catch {
      continue;
    }
  }
  throw new Error('Worker source template not found');
}

function cancel(): never {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

export async function main(argv: string[]): Promise<void> {
  const version = '0.1.0';

  // --help flag
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
  ${pc.bold('create-flarelytics')} v${version}

  Set up Flarelytics privacy-first analytics in under 3 minutes.

  ${pc.dim('Usage:')}
    npx create-flarelytics [project-directory]

  ${pc.dim('Options:')}
    --help, -h       Show this help message
    --version, -v    Show version
`);
    return;
  }

  // --version flag
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(version);
    return;
  }

  p.intro(`${pc.bold('create-flarelytics')} ${pc.dim(`v${version}`)}`);

  // Prerequisites
  const node = checkNodeVersion();
  if (!node.ok) {
    p.log.error(`Node.js ${node.version} detected. Flarelytics requires Node.js >= 22.`);
    process.exit(1);
  }

  const s = p.spinner();
  s.start('Checking wrangler...');
  const wranglerCheck = await checkWrangler();
  if (!wranglerCheck.ok) {
    s.stop('Wrangler not found');
    p.log.error('Wrangler is required. Run: npm install -g wrangler');
    process.exit(1);
  }
  s.stop('Wrangler available');

  // Project directory
  const dirArg = argv.find((a) => !a.startsWith('-'));
  const projectDir = dirArg || (await (async () => {
    const result = await p.text({
      message: 'Where should we create your project?',
      placeholder: './my-analytics',
      defaultValue: './my-analytics',
      validate: (v = '') => {
        if (!v.trim()) return 'Directory name is required';
      },
    });
    if (p.isCancel(result)) cancel();
    return result as string;
  })());

  const targetDir = resolve(process.cwd(), projectDir);

  // Cloudflare Account ID
  const accountId = await p.text({
    message: 'Cloudflare Account ID',
    placeholder: 'Find at: dash.cloudflare.com → any zone → Overview sidebar',
    validate: (v = '') => {
      if (!v.trim()) return 'Account ID is required';
      if (!/^[a-f0-9]{32}$/.test(v.trim())) return 'Account ID should be a 32-character hex string';
    },
  });
  if (p.isCancel(accountId)) cancel();

  // CF API Token
  const apiToken = await p.password({
    message: 'Cloudflare API Token',
    validate: (v = '') => {
      if (!v.trim()) return 'API token is required';
    },
  });
  if (p.isCancel(apiToken)) cancel();

  // Validate token and account
  s.start('Validating credentials...');
  const tokenResult = await validateToken(apiToken as string);
  if (!tokenResult.valid) {
    s.stop('Token invalid');
    p.log.error(`Token validation failed: ${tokenResult.error}`);
    p.log.info('Create a token at: dash.cloudflare.com/profile/api-tokens');
    p.log.info('Required permissions: Account > Account Analytics > Read');
    process.exit(1);
  }

  const accountResult = await validateAccount(apiToken as string, (accountId as string).trim());
  if (!accountResult.valid) {
    s.stop('Account validation failed');
    p.log.error(`Account validation failed: ${accountResult.error}`);
    process.exit(1);
  }
  s.stop(`Credentials valid ${pc.dim(`(${accountResult.name})`)}`);

  // Allowed origins
  const allowedOrigins = await p.text({
    message: 'Allowed origins (comma-separated)',
    placeholder: 'https://mysite.com,http://localhost:3000',
    validate: (v = '') => {
      if (!v.trim()) return 'At least one origin is required';
      const origins = v.split(',').map((o) => o.trim());
      for (const origin of origins) {
        if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
          return `Origin "${origin}" must start with http:// or https://`;
        }
      }
    },
  });
  if (p.isCancel(allowedOrigins)) cancel();

  // Dataset name
  const datasetName = await p.text({
    message: 'Dataset name',
    placeholder: 'flarelytics',
    defaultValue: 'flarelytics',
    validate: (v = '') => {
      if (!v.trim()) return 'Dataset name is required';
      if (!/^[a-z0-9-]+$/.test(v.trim())) return 'Only lowercase letters, numbers, and hyphens allowed';
    },
  });
  if (p.isCancel(datasetName)) cancel();

  // Deploy now?
  const shouldDeploy = await p.confirm({
    message: 'Deploy to Cloudflare now?',
    initialValue: true,
  });
  if (p.isCancel(shouldDeploy)) cancel();

  // Scaffold project
  s.start('Creating project files...');
  let workerSource: string;
  try {
    workerSource = await getWorkerSource();
  } catch {
    s.stop('Failed to load worker template');
    p.log.error('Could not load the worker source template.');
    process.exit(1);
  }

  try {
    const result = await scaffold(targetDir, {
      accountId: (accountId as string).trim(),
      datasetName: (datasetName as string).trim(),
      allowedOrigins: (allowedOrigins as string).trim(),
    }, workerSource);
    s.stop('Project files created');
    for (const f of result.files) {
      p.log.step(pc.dim(f));
    }
  } catch (err) {
    s.stop('Failed to create project');
    p.log.error((err as Error).message);
    process.exit(1);
  }

  // Install dependencies
  s.start('Installing dependencies...');
  const installResult = await new Promise<boolean>((res) => {
    execFile('npm', ['install'], { cwd: targetDir, timeout: 120_000 }, (err) => res(!err));
  });
  if (!installResult) {
    s.stop('npm install failed');
    p.log.warn(`Run ${pc.bold('npm install')} manually in ${projectDir}`);
  } else {
    s.stop('Dependencies installed');
  }

  if (!shouldDeploy) {
    p.outro(`Project created at ${pc.bold(projectDir)}\n\n  To deploy later:\n  cd ${projectDir} && npx wrangler deploy`);
    return;
  }

  // Check wrangler auth
  s.start('Checking wrangler authentication...');
  const auth = await wrangler.checkAuth();
  if (!auth.authenticated) {
    s.stop('Not authenticated');
    p.log.info('Opening browser for Cloudflare login...');
    const loginOk = await wrangler.login();
    if (!loginOk) {
      p.log.error('Wrangler login failed. Run `npx wrangler login` manually, then `npx wrangler deploy`.');
      process.exit(1);
    }
  } else {
    s.stop(`Authenticated ${pc.dim(`(${auth.email})`)}`);
  }

  // Deploy
  s.start('Deploying worker...');
  const deployResult = await wrangler.deploy(targetDir);
  if (!deployResult.ok) {
    s.stop('Deploy failed');
    p.log.error(deployResult.error || 'Unknown error');
    p.log.info(`Fix the issue, then run: cd ${projectDir} && npx wrangler deploy`);
    process.exit(1);
  }
  const workerUrl = deployResult.url || `https://${(datasetName as string).trim()}.workers.dev`;
  s.stop(`Deployed ${pc.dim(workerUrl)}`);

  // Set secrets
  const apiKey = generateApiKey();
  const secrets = [
    { name: 'QUERY_API_KEY', value: apiKey },
    { name: 'CF_API_TOKEN', value: (apiToken as string).trim() },
    { name: 'CF_ACCOUNT_ID', value: (accountId as string).trim() },
  ];

  for (const secret of secrets) {
    s.start(`Setting ${secret.name}...`);
    const result = await wrangler.secretPut(secret.name, secret.value, targetDir);
    if (!result.ok) {
      s.stop(`Failed to set ${secret.name}`);
      p.log.warn(`Set manually: echo "value" | npx wrangler secret put ${secret.name}`);
    } else {
      s.stop(`${secret.name} set`);
    }
  }

  // Health check (retry once after short delay)
  s.start('Running health check...');
  let health = await wrangler.healthCheck(workerUrl);
  if (!health.ok) {
    await new Promise((r) => setTimeout(r, 2000));
    health = await wrangler.healthCheck(workerUrl);
  }
  if (health.ok) {
    s.stop('Health check passed');
  } else {
    s.stop('Health check pending');
    p.log.warn('The worker may still be propagating. Check manually:');
    p.log.warn(`curl ${workerUrl}/health`);
  }

  // Summary
  const divider = pc.dim('─'.repeat(50));
  p.outro(`Setup complete!

${divider}

  ${pc.bold('Worker URL:')}   ${workerUrl}
  ${pc.bold('API Key:')}      ${apiKey}  ${pc.dim('(save this!)')}

${divider}

  Add to your site:

  ${pc.cyan(`<script defer src="${workerUrl}/tracker.js"></script>`)}

  Or install the npm package:

  ${pc.cyan('npm install @flarelytics/tracker')}

${divider}

  Dashboard: ${pc.cyan('https://flarelytics-dashboard.pages.dev')}
  Enter your Worker URL, API Key, and site hostname.
`);
}
