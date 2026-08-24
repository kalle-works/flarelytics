import { describe, it, expect } from 'vitest';
import { verifyEs256, base64urlEncode, utf8ToBytes } from './crypto';
import { verifyIdToken, generatePkce, generateState, generateNonce } from './oidc';

// ─── verifyEs256 (pure Web Crypto, no network) ───────────────────────────────
describe('verifyEs256', () => {
  async function makeKeyAndJwk() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as { kty?: string; crv?: string; x?: string; y?: string };
    return { priv: pair.privateKey, jwk };
  }

  async function sign(priv: CryptoKey, data: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, utf8ToBytes(data)));
  }

  it('verifies a valid P-256 signature', async () => {
    const { priv, jwk } = await makeKeyAndJwk();
    const sig = await sign(priv, 'hello.world');
    expect(await verifyEs256(jwk, 'hello.world', sig)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const { priv, jwk } = await makeKeyAndJwk();
    const sig = await sign(priv, 'hello.world');
    expect(await verifyEs256(jwk, 'hello.WORLD', sig)).toBe(false);
  });

  it('rejects a non-EC / wrong-curve key', async () => {
    const { priv, jwk } = await makeKeyAndJwk();
    const sig = await sign(priv, 'hello.world');
    expect(await verifyEs256({ ...jwk, crv: 'P-384' }, 'hello.world', sig)).toBe(false);
    expect(await verifyEs256({ kty: 'RSA' }, 'hello.world', sig)).toBe(false);
  });
});

// ─── verifyIdToken pre-fetch guards (alg confusion, malformed) ────────────────
// These run before any JWKS network call, so they need no mocking. They cover
// the highest-risk verification bypass: alg:none / alg swap.
describe('verifyIdToken guards', () => {
  function jwt(header: object, payload: object): string {
    const h = base64urlEncode(utf8ToBytes(JSON.stringify(header)));
    const p = base64urlEncode(utf8ToBytes(JSON.stringify(payload)));
    return `${h}.${p}.AAAA`;
  }
  const opts = { issuer: 'https://id.palvelureppu.fi', clientId: 'flarelytics' };

  it('rejects a token that is not three parts', async () => {
    await expect(verifyIdToken({ idToken: 'not.a.valid.jwt.x', ...opts })).rejects.toThrow();
    await expect(verifyIdToken({ idToken: 'onlyonepart', ...opts })).rejects.toThrow();
  });

  it('rejects alg:none (downgrade attack)', async () => {
    const token = jwt({ alg: 'none' }, { sub: 'x' });
    await expect(verifyIdToken({ idToken: token, ...opts })).rejects.toThrow(/ES256/);
  });

  it('rejects a non-ES256 alg (HS256 confusion)', async () => {
    const token = jwt({ alg: 'HS256', kid: 'k' }, { sub: 'x' });
    await expect(verifyIdToken({ idToken: token, ...opts })).rejects.toThrow(/ES256/);
  });

  it('rejects a token with a non-JSON header', async () => {
    await expect(verifyIdToken({ idToken: 'bm90anNvbg.bm90anNvbg.AAAA', ...opts })).rejects.toThrow();
  });
});

// ─── PKCE / state / nonce generation ─────────────────────────────────────────
describe('PKCE + state + nonce', () => {
  it('generatePkce produces a verifier and S256 challenge', async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    expect(verifier).not.toBe(challenge);
  });

  it('state and nonce are random and distinct', () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
