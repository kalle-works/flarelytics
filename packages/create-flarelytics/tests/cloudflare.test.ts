import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateToken, validateAccount } from '../src/cloudflare.js';

describe('validateToken', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid for active token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, result: { status: 'active' } }),
    });

    const result = await validateToken('good-token');
    expect(result.valid).toBe(true);
  });

  it('returns invalid for expired token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: false,
        errors: [{ message: 'Token expired' }],
      }),
    });

    const result = await validateToken('bad-token');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Token expired');
  });

  it('handles network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await validateToken('any-token');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('calls the correct CF API endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, result: { status: 'active' } }),
    });

    await validateToken('test-token');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });
});

describe('validateAccount', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid with account name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, result: { name: 'My Account' } }),
    });

    const result = await validateAccount('token', 'account-id');
    expect(result.valid).toBe(true);
    expect(result.name).toBe('My Account');
  });

  it('returns invalid for wrong account', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: false,
        errors: [{ message: 'Account not found' }],
      }),
    });

    const result = await validateAccount('token', 'bad-id');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Account not found');
  });

  it('calls the correct CF API endpoint with account ID', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, result: { name: 'Test' } }),
    });

    await validateAccount('token', 'abc123');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/abc123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      }),
    );
  });
});
