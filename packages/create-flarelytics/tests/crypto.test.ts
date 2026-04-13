import { describe, it, expect } from 'vitest';
import { generateApiKey } from '../src/crypto.js';

describe('generateApiKey', () => {
  it('returns a 32-character hex string', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });
});
