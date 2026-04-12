import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the JSON string passed to Blob constructor
let lastBlobContent = '';
const OrigBlob = globalThis.Blob;
globalThis.Blob = class FakeBlob extends OrigBlob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    if (parts && parts.length) lastBlobContent = String(parts[0]);
  }
} as typeof Blob;

const beaconSpy = vi.fn(() => true);
Object.defineProperty(navigator, 'sendBeacon', { value: beaconSpy, writable: true });

describe('tracker', () => {
  beforeEach(() => {
    beaconSpy.mockClear();
    lastBlobContent = '';
    vi.resetModules();
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
});
