import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the JSON string passed to Blob constructor. `sentPayloads` keeps
// every payload sent during a test (in order); `lastBlobContent` keeps the
// existing single-payload convenience the pre-existing tests rely on.
let lastBlobContent = '';
let sentPayloads: string[] = [];
const OrigBlob = globalThis.Blob;
globalThis.Blob = class FakeBlob extends OrigBlob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    if (parts && parts.length) {
      lastBlobContent = String(parts[0]);
      sentPayloads.push(lastBlobContent);
    }
  }
} as typeof Blob;

const beaconSpy = vi.fn((_url: string, _data?: BodyInit | null) => true);
Object.defineProperty(navigator, 'sendBeacon', { value: beaconSpy, writable: true, configurable: true });

// Capture the native, unpatched history methods once at module load — before
// any test has had a chance to call tracker.init() and wrap them for SPA
// tracking. Tests restore these in afterEach so wrapping from one test never
// stacks onto the next (each test file shares one jsdom `history` object).
const NATIVE_PUSH_STATE = history.pushState.bind(history);
const NATIVE_REPLACE_STATE = history.replaceState.bind(history);

// `document`/`window` are shared across every test in this file (jsdom
// creates one environment per test file, not per test). Every tracker.init()
// call registers click/auxclick/visibilitychange/pagehide listeners that
// would otherwise accumulate test after test and all fire together on the
// next dispatched event. Record what each test's init() adds and remove it
// in afterEach so each test starts with a clean listener slate.
type ListenerRecord = {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
};
let addedListeners: ListenerRecord[] = [];

const originalDocAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => {
  addedListeners.push({ target: document, type, listener });
  return originalDocAddEventListener(type, listener, options);
}) as typeof document.addEventListener;

const originalWinAddEventListener = window.addEventListener.bind(window);
window.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => {
  addedListeners.push({ target: window, type, listener });
  return originalWinAddEventListener(type, listener, options);
}) as typeof window.addEventListener;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(target: Element): void {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

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
    sentPayloads = [];
    vi.resetModules();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
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
    // Undo any history.pushState/replaceState wrapping a test's init() call
    // installed, and reset the (shared, mutable) jsdom Location back to a
    // known baseline so SPA-navigation tests never see another test's path.
    history.pushState = NATIVE_PUSH_STATE;
    history.replaceState = NATIVE_REPLACE_STATE;
    NATIVE_REPLACE_STATE(null, '', 'https://example.com/');
    for (const { target, type, listener } of addedListeners) {
      target.removeEventListener(type, listener);
    }
    addedListeners = [];
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

  describe('timing: visibilitychange resets the clock instead of accumulating', () => {
    it('reports the time since the *last visible period*, not cumulative time since load', async () => {
      const tracker = await import('./tracker');
      const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get');
      try {
        vi.useFakeTimers();
        tracker.init('https://analytics.example.com');
        beaconSpy.mockClear();
        sentPayloads = [];

        vi.advanceTimersByTime(10_000);
        visibilitySpy.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));

        visibilitySpy.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));

        vi.advanceTimersByTime(5_000);
        visibilitySpy.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));

        const timingSeconds = sentPayloads
          .map((p) => JSON.parse(p))
          .filter((p) => p.event === 'timing')
          .map((p) => p.props.seconds);
        expect(timingSeconds).toEqual(['10', '5']);
      } finally {
        vi.useRealTimers();
        visibilitySpy.mockRestore();
      }
    });

    it('flushes a timing event on pagehide (bfcache / tab close)', async () => {
      const tracker = await import('./tracker');
      try {
        vi.useFakeTimers();
        tracker.init('https://analytics.example.com');
        beaconSpy.mockClear();
        sentPayloads = [];

        vi.advanceTimersByTime(8_000);
        window.dispatchEvent(new Event('pagehide'));

        const timingPayloads = sentPayloads.map((p) => JSON.parse(p)).filter((p) => p.event === 'timing');
        expect(timingPayloads).toHaveLength(1);
        expect(timingPayloads[0].props.seconds).toBe('8');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('SPA navigation tracking', () => {
    it('fires a pageview with the new path (and no referrer) on pushState to a different path', async () => {
      NATIVE_REPLACE_STATE(null, '', 'https://example.com/');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      history.pushState(null, '', '/new-page');

      const pageviews = sentPayloads.map((p) => JSON.parse(p)).filter((p) => p.event === 'pageview');
      expect(pageviews).toHaveLength(1);
      expect(pageviews[0].path).toBe('/new-page');
      expect(pageviews[0]).not.toHaveProperty('referrer');
    });

    it('does not fire a pageview when pushState targets the current path', async () => {
      NATIVE_REPLACE_STATE(null, '', 'https://example.com/same');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      history.pushState(null, '', '/same');

      expect(sentPayloads).toHaveLength(0);
    });

    it('data-no-spa / { noSpa: true } disables automatic pushState tracking', async () => {
      NATIVE_REPLACE_STATE(null, '', 'https://example.com/');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com', { noSpa: true });
      beaconSpy.mockClear();
      sentPayloads = [];

      history.pushState(null, '', '/other-page');

      expect(sentPayloads).toHaveLength(0);
    });
  });

  describe('outbound link tracking', () => {
    it('registers auxclick middle-click (button 1) on an external link as outbound', async () => {
      document.body.innerHTML = '<a id="a1" href="https://other.com/page">link</a>';
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      document.getElementById('a1')!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));

      const outbound = sentPayloads.map((p) => JSON.parse(p)).filter((p) => p.event === 'outbound');
      expect(outbound).toHaveLength(1);
      expect(outbound[0].props.url).toBe('other.com/page');
    });

    it('ignores auxclick for right-click (button 2)', async () => {
      document.body.innerHTML = '<a id="a1" href="https://other.com/page">link</a>';
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      document.getElementById('a1')!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }));

      expect(sentPayloads.filter((p) => JSON.parse(p).event === 'outbound')).toHaveLength(0);
    });

    it('treats a subdomain of the current site as internal, not outbound', async () => {
      stubLocation('https://example.com/');
      document.body.innerHTML = '<a id="a1" href="https://blog.example.com/post">link</a>';
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      const anchor = document.getElementById('a1')!;
      anchor.addEventListener('click', (e) => e.preventDefault()); // jsdom doesn't implement real navigation
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));

      expect(sentPayloads.filter((p) => JSON.parse(p).event === 'outbound')).toHaveLength(0);
    });

    it('still registers a genuinely external click as outbound', async () => {
      stubLocation('https://example.com/');
      document.body.innerHTML = '<a id="a1" href="https://unrelated.org/post">link</a>';
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      beaconSpy.mockClear();
      sentPayloads = [];

      const anchor = document.getElementById('a1')!;
      anchor.addEventListener('click', (e) => e.preventDefault()); // jsdom doesn't implement real navigation
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));

      const outbound = sentPayloads.map((p) => JSON.parse(p)).filter((p) => p.event === 'outbound');
      expect(outbound).toHaveLength(1);
      expect(outbound[0].props.url).toBe('unrelated.org/post');
    });
  });

  describe('localhost / dev exclusion', () => {
    it('does not send events on localhost by default', async () => {
      stubLocation('http://localhost:3000/');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      expect(beaconSpy).not.toHaveBeenCalled();
    });

    it('does not send events on 127.0.0.1 by default', async () => {
      stubLocation('http://127.0.0.1:8080/');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      expect(beaconSpy).not.toHaveBeenCalled();
    });

    it('does not send events on file: pages by default', async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, protocol: 'file:', hostname: '', href: 'file:///index.html', pathname: '/index.html' },
      });
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com');
      expect(beaconSpy).not.toHaveBeenCalled();
    });

    it('sends events on localhost when allowLocalhost is set', async () => {
      stubLocation('http://localhost:3000/');
      const tracker = await import('./tracker');
      tracker.init('https://analytics.example.com', { allowLocalhost: true });
      expect(beaconSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetch fallback (no sendBeacon)', () => {
    it('POSTs via fetch with keepalive when sendBeacon is unavailable', async () => {
      const originalSendBeacon = navigator.sendBeacon;
      Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true });
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchSpy);

      try {
        const tracker = await import('./tracker');
        tracker.init('https://analytics.example.com');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://analytics.example.com/track');
        expect(opts.method).toBe('POST');
        expect(opts.keepalive).toBe(true);
        expect(opts.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(opts.body).event).toBe('pageview');
      } finally {
        Object.defineProperty(navigator, 'sendBeacon', { value: originalSendBeacon, configurable: true, writable: true });
        vi.unstubAllGlobals();
      }
    });

    it('swallows fetch fallback failures instead of surfacing an unhandled rejection', async () => {
      const originalSendBeacon = navigator.sendBeacon;
      Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true });
      // A plain function, not vi.fn(): vitest's spy wrapper consumes the
      // returned promise for its own call-tracking bookkeeping, which would
      // mask an unhandled rejection regardless of whether tracker.ts catches
      // it — defeating the point of this test.
      let fetchCalls = 0;
      vi.stubGlobal('fetch', () => {
        fetchCalls++;
        return Promise.reject(new Error('network down'));
      });

      const unhandledReasons: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandledReasons.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        const tracker = await import('./tracker');
        tracker.init('https://analytics.example.com');
        expect(fetchCalls).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandledReasons).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        Object.defineProperty(navigator, 'sendBeacon', { value: originalSendBeacon, configurable: true, writable: true });
        vi.unstubAllGlobals();
      }
    });
  });

  describe('scroll depth milestone dedup', () => {
    it('sends each milestone at most once even if the sentinel intersects repeatedly', async () => {
      FakeIntersectionObserver.instances.length = 0;
      (window as any).IntersectionObserver = FakeIntersectionObserver;

      try {
        const tracker = await import('./tracker');
        tracker.init('https://analytics.example.com', { scrollDepth: true });
        beaconSpy.mockClear();
        sentPayloads = [];

        const observer = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
        const sentinel25 = document.body.querySelector('div[data-sd="25"]') as HTMLElement;
        expect(sentinel25).toBeTruthy();

        // Scrolling back up and past 25% again re-triggers the observer for
        // the same milestone — must not send a second scroll_depth event.
        observer.trigger(sentinel25);
        observer.trigger(sentinel25);

        const scrollEvents = sentPayloads.map((p) => JSON.parse(p)).filter((p) => p.event === 'scroll_depth');
        expect(scrollEvents).toHaveLength(1);
        expect(scrollEvents[0].props.depth).toBe('25');
      } finally {
        delete (window as any).IntersectionObserver;
      }
    });
  });
});
