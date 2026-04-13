export interface WorkerConfig {
  accountId: string;
  datasetName: string;
  allowedOrigins: string;
}

export function generateWranglerToml(config: WorkerConfig): string {
  return `name = "${config.datasetName}"
account_id = "${config.accountId}"
main = "src/index.ts"
compatibility_date = "2025-03-01"
compatibility_flags = ["nodejs_compat"]

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "${config.datasetName}"

[vars]
ALLOWED_ORIGINS = "${config.allowedOrigins}"
DATASET_NAME = "${config.datasetName}"

# Secrets (set via \`wrangler secret put\`):
#   QUERY_API_KEY  — random string for dashboard authentication
#   CF_API_TOKEN   — Cloudflare API token with these permissions:
#                    Account > Account Analytics > Read
#                    Zone resources: All zones (or specific zones)
#                    Create at: https://dash.cloudflare.com/profile/api-tokens
#   CF_ACCOUNT_ID  — your Cloudflare account ID
#                    Find at: https://dash.cloudflare.com → any zone → Overview sidebar
`;
}

export function generatePackageJson(name: string): string {
  return JSON.stringify(
    {
      name: `${name}-analytics`,
      version: '0.0.1',
      private: true,
      scripts: {
        dev: 'wrangler dev',
        deploy: 'wrangler deploy',
      },
      devDependencies: {
        '@cloudflare/workers-types': '^4.20250312.0',
        typescript: '^5.8.0',
        wrangler: '^4.0.0',
      },
    },
    null,
    2,
  ) + '\n';
}

export function generateTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        lib: ['ES2022'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ) + '\n';
}
