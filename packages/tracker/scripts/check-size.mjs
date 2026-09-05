#!/usr/bin/env node
// Size gate for the served tracker bundle. Fails the build if the gzipped
// dist/tracker.iife.js grows past BUDGET_BYTES, so a feature addition that
// blows the "under Xkb gzipped" claim in the README/landing page is caught
// in CI instead of discovered after users start filing "why did our page
// load slow down" issues.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(__dirname, '../dist/tracker.iife.js');

// Measured gzipped size after the SPA/timing/outbound/localhost fixes was
// 1834 bytes; budget rounds that up to the next 100 bytes so routine
// changes don't need a bump, while still catching real bloat.
const BUDGET_BYTES = 1900;

let raw;
try {
  raw = readFileSync(BUNDLE_PATH);
} catch (err) {
  console.error(`[size] could not read ${BUNDLE_PATH} — run the iife build first.`);
  console.error(err.message);
  process.exit(1);
}

const gzipped = gzipSync(raw, { level: 9 });
const size = gzipped.length;

console.log(`[size] tracker.iife.js: ${raw.length} bytes raw, ${size} bytes gzipped (budget: ${BUDGET_BYTES})`);

if (size > BUDGET_BYTES) {
  console.error(`[size] gzipped size ${size} bytes exceeds budget of ${BUDGET_BYTES} bytes.`);
  console.error('[size] either trim the tracker or raise BUDGET_BYTES deliberately and update the README/landing/package.json size claims to match.');
  process.exit(1);
}
