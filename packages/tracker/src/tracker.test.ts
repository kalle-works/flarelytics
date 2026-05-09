import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the JSON string passed to Blob constructor
let lastBlobContent = '';
const OrigBlob = globalThis.Blob;
globalThis.Blob = class FakeBlob extends OrigBlob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    if (parts && parts.length) lastBlobContent = String(parts[0]);
  }
} as typeof Blob;

const beaconSpy = vi.fn((_url: string, _data?: BodyInit | null) => true);
Object.defineProperty(navigator, 'sendBeacon', { value: beaconSpy, writable: true });

function stubLocation(href: string): void {
  const u = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: u.href,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      hostname: u.hostname,
      host: u.host,
      protocol: u.protocol,
      port: u.port,
      origin: u.origin,
    },
  });
}

const ORIGINAL_LOCATION = window.location;

describe('tracker', () => {
  beforeEach(() => {
    beaconSpy.mockClear();
    lastBlobContent = '';
    vi.resetModules();
    document.head.innerHTML = '';
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: null,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: ORIGINAL_LOCATION,
    });
  });

  it('exports init and track functions', async () => {
    const tracker = await import('./tracker');
    expect(typeof tracker.init).toBe('function');
    expect(typeof tracker.track).toBe('function');
  });

  it('init sends a pageview event', async () => {
    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com');

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [url] = beaconSpy.mock.calls[0];
    expect(url).toBe('https://analytics.example.com/track');

    const payload = JSON.parse(lastBlobContent);
    expect(payload.event).toBe('pageview');
    expect(payload.path).toBe('/');
    expect(payload.referrer).toBe('direct');
  });

  it('track sends custom event', async () => {
    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com');
    beaconSpy.mockClear();

    tracker.track('signup', { props: { plan: 'pro' } });

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [url] = beaconSpy.mock.calls[0];
    expect(url).toBe('https://analytics.example.com/track');

    const payload = JSON.parse(lastBlobContent);
    expect(payload.event).toBe('signup');
    expect(payload.props).toEqual({ plan: 'pro' });
  });

  it('strips trailing slash from endpoint', async () => {
    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com/');

    const [url] = beaconSpy.mock.calls[0];
    expect(url).toBe('https://analytics.example.com/track');
  });

  it('does not send before init', async () => {
    const tracker = await import('./tracker');
    beaconSpy.mockClear();
    tracker.track('test');
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('omits canonical_url when feature flag is off', async () => {
    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com');

    const payload = JSON.parse(lastBlobContent);
    expect(payload.event).toBe('pageview');
    expect(payload).not.toHaveProperty('canonical_url');
  });

  it('emits canonical_url from <link rel="canonical"> when flag on', async () => {
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = 'https://kiiru.fi/a/foo';
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/a/foo');
  });

  it('normalizes location.href when no canonical tag (host case, default port, fragment, trailing slash)', async () => {
    stubLocation('https://Kiiru.fi:443/Path/#frag');

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/Path');
  });

  it('preserves trailing slash on root path', async () => {
    stubLocation('https://kiiru.fi/');

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/');
  });

  it('resolves relative canonical href against location', async () => {
    stubLocation('https://kiiru.fi/foo');
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.setAttribute('href', '/canonical-path');
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/canonical-path');
  });

  it('falls back to location.href when canonical href is empty', async () => {
    stubLocation('https://kiiru.fi/foo');
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.setAttribute('href', '');
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/foo');
  });

  it('does not emit canonical_url for non-pageview events', async () => {
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = 'https://kiiru.fi/a/foo';
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });
    beaconSpy.mockClear();
    lastBlobContent = '';

    tracker.track('signup', { props: { plan: 'pro' } });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.event).toBe('signup');
    expect(payload).not.toHaveProperty('canonical_url');
  });

  it('strips userinfo (user:pass@) from canonical_url', async () => {
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.setAttribute('href', 'https://user:pass@kiiru.fi/a/leak');
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/a/leak');
    expect(payload.canonical_url).not.toContain('user');
    expect(payload.canonical_url).not.toContain('pass');
  });

  it('rejects javascript: scheme canonical and falls back to location.href', async () => {
    stubLocation('https://kiiru.fi/safe');
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.setAttribute('href', 'javascript:alert(1)');
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/safe');
    expect(payload.canonical_url).not.toContain('javascript:');
  });

  it('rejects file:// canonical and falls back to location.href', async () => {
    stubLocation('https://kiiru.fi/safe');
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.setAttribute('href', 'file:///etc/passwd');
    document.head.appendChild(link);

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload.canonical_url).toBe('https://kiiru.fi/safe');
    expect(payload.canonical_url).not.toContain('file:');
  });

  it('omits canonical_url when location.href itself is non-http(s)', async () => {
    stubLocation('https://kiiru.fi/x');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, href: 'about:blank', protocol: 'about:' },
    });

    const tracker = await import('./tracker');
    tracker.init('https://analytics.example.com', { emitCanonical: true });

    const payload = JSON.parse(lastBlobContent);
    expect(payload).not.toHaveProperty('canonical_url');
  });

  it('reads emitCanonical feature flag from script data-attribute', async () => {
    const script = document.createElement('script');
    script.dataset.endpoint = 'https://analytics.example.com';
    script.dataset.emitCanonical = 'true';
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: script,
    });
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = 'https://kiiru.fi/auto-init';
    document.head.appendChild(link);

    await import('./tracker');

    const payload = JSON.parse(lastBlobContent);
    expect(payload.event).toBe('pageview');
    expect(payload.canonical_url).toBe('https://kiiru.fi/auto-init');
  });
});
