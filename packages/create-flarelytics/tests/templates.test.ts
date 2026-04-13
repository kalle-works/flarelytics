import { describe, it, expect } from 'vitest';
import { generateWranglerToml, generatePackageJson, generateTsconfig } from '../src/templates.js';

describe('generateWranglerToml', () => {
  const config = {
    accountId: 'abc123def456abc123def456abc123de',
    datasetName: 'my-site',
    allowedOrigins: 'https://mysite.com,http://localhost:3000',
  };

  it('includes the account ID', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain(`account_id = "${config.accountId}"`);
  });

  it('includes the dataset name in analytics engine binding', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain(`dataset = "${config.datasetName}"`);
  });

  it('includes allowed origins', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain(`ALLOWED_ORIGINS = "${config.allowedOrigins}"`);
  });

  it('sets the worker name to dataset name', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain(`name = "${config.datasetName}"`);
  });

  it('includes compatibility date and flags', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain('compatibility_date = "2025-03-01"');
    expect(toml).toContain('nodejs_compat');
  });

  it('includes DATASET_NAME var', () => {
    const toml = generateWranglerToml(config);
    expect(toml).toContain(`DATASET_NAME = "${config.datasetName}"`);
  });
});

describe('generatePackageJson', () => {
  it('returns valid JSON', () => {
    const json = generatePackageJson('my-site');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes the project name', () => {
    const pkg = JSON.parse(generatePackageJson('my-site'));
    expect(pkg.name).toBe('my-site-analytics');
  });

  it('includes wrangler as dev dependency', () => {
    const pkg = JSON.parse(generatePackageJson('test'));
    expect(pkg.devDependencies.wrangler).toBeDefined();
  });

  it('includes deploy script', () => {
    const pkg = JSON.parse(generatePackageJson('test'));
    expect(pkg.scripts.deploy).toBe('wrangler deploy');
  });
});

describe('generateTsconfig', () => {
  it('returns valid JSON', () => {
    expect(() => JSON.parse(generateTsconfig())).not.toThrow();
  });

  it('targets ES2022', () => {
    const config = JSON.parse(generateTsconfig());
    expect(config.compilerOptions.target).toBe('ES2022');
  });

  it('includes workers types', () => {
    const config = JSON.parse(generateTsconfig());
    expect(config.compilerOptions.types).toContain('@cloudflare/workers-types');
  });
});
