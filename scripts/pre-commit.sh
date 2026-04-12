#!/usr/bin/env bash
set -e

echo "Running type checks..."
cd packages/worker && npx tsc --noEmit
cd ../tracker && npx tsc --noEmit
cd ../..

echo "Running tests..."
cd packages/worker && npx vitest run
cd ../tracker && npx vitest run
cd ../..

echo "All checks passed."
