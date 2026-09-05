/**
 * Flarelytics Tracker — lightweight client-side analytics (under 2KB gzipped)
 *
 * Usage (script tag):
 *   <script defer data-endpoint="https://your-worker.workers.dev" src="/tracker.js"></script>
 *
 * Usage (npm):
 *   import { init, track } from '@flarelytics/tracker'
 *   init('https://your-worker.workers.dev')
 *   track('signup', { props: { plan: 'pro' } })
 */

// Replaced by the worker at serve time (see tracker-script.ts) with the
// worker's own origin, so a bare `<script src=".../tracker.js">` with no
// `data-endpoint` attribute still auto-inits against the worker that served
// it. Left untouched, this stays a placeholder that never resolves to a real
// endpoint (auto-init falls back to "no endpoint" — a no-op — instead of
// sending to a nonsense host).
const DEFAULT_ENDPOINT = '__ENDPOINT__';

function defaultEndpoint(): string {
  return DEFAULT_ENDPOINT.indexOf('__') === 0 ? '' : DEFAULT_ENDPOINT;
}

let endpoint = '';
let emitCanonical = false;
let allowLocalhost = false;
let scrollDepthEnabled = false;

interface TrackOptions {
  props?: Record<string, string>;
  path?: string;
  /** Revenue or conversion value — passed to the worker as double3 for revenue queries */
  value?: number;
}

export interface InitOptions {
  /** Track scroll depth at 25/50/75/100% milestones using IntersectionObserver */
  scrollDepth?: boolean;
  /** Emit normalized canonical_url on pageview events */
  emitCanonical?: boolean;
  /** Send events while running on localhost/127.0.0.1/[::1]/file: (default: false) */
  allowLocalhost?: boolean;
  /** Disable automatic SPA pageview tracking (history.pushState/replaceState/popstate) */
  noSpa?: boolean;
}

function isLocalEnvironment(): boolean {
  if (location.protocol === 'file:') return true;
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function resolveCanonical(): string | null {
  let raw = location.href;
  const link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  const href = link?.getAttribute('href');
  if (href) {
    try {
      const candidate = new URL(href, location.href);
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
        raw = candidate.toString();
      }
    } catch {}
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.username = '';
    u.password = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function send(event: string, data: Record<string, unknown> = {}, opts: { noReferrer?: boolean } = {}): void {
  if (!endpoint) return;
  if (isLocalEnvironment() && !allowLocalhost) return;

  const payload: Record<string, unknown> = {
    event,
    path: data.path || location.pathname,
    ...data,
  };

  if (event === 'pageview') {
    if (!opts.noReferrer) {
      const ref = document.referrer;
      if (ref) {
        try { payload.referrer = new URL(ref).hostname; }
        catch { payload.referrer = ref; }
      } else {
        payload.referrer = 'direct';
      }
    }

    // UTM params
    const params = new URLSearchParams(location.search);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const val = params.get(key);
      if (val) payload[key] = val;
    }

    if (emitCanonical) {
      const canonical = resolveCanonical();
      if (canonical) payload.canonical_url = canonical;
    }
  }

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(endpoint + '/track', blob);
  } else {
    fetch(endpoint + '/track', {
      method: 'POST',
      body: json,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }).catch(() => {});
  }
}

// --- Registrable-domain check for outbound-link detection --------------------
// Not public-suffix-list aware (e.g. mis-detects `foo.co.uk` vs `bar.co.uk` as
// the same site), but correctly treats ordinary subdomains of the current
// site (blog.example.com vs example.com) as internal rather than outbound.
function registrableDomain(hostname: string): string {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

function isInternalLink(url: URL): boolean {
  if (url.hostname === location.hostname) return true;
  return registrableDomain(url.hostname) === registrableDomain(location.hostname);
}

function handleOutboundClick(e: MouseEvent): void {
  // auxclick fires for middle-click (button 1) and right-click (button 2);
  // only middle-click opens a link, so ignore everything else on auxclick.
  if (e.type === 'auxclick' && e.button !== 1) return;
  const target = e.target as HTMLElement | null;
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return;
  try {
    const url = new URL(anchor.href);
    if (isInternalLink(url)) return;
    send('outbound', { props: { url: url.hostname + url.pathname } });
  } catch {}
}

// --- Scroll depth -------------------------------------------------------------
let scrollObserver: IntersectionObserver | null = null;
let scrollSentinels: HTMLElement[] = [];

function teardownScrollDepth(): void {
  scrollObserver?.disconnect();
  scrollObserver = null;
  for (const el of scrollSentinels) el.remove();
  scrollSentinels = [];
}

function initScrollDepth(): void {
  if (!('IntersectionObserver' in window)) return;

  const fired = new Set<number>();
  const depths = [25, 50, 75, 100];

  scrollObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const depth = parseInt((entry.target as HTMLElement).dataset.sd || '0', 10);
      if (depth && !fired.has(depth)) {
        fired.add(depth);
        send('scroll_depth', { props: { depth: String(depth) } });
        if (fired.size === depths.length) scrollObserver?.disconnect();
      }
    }
  });

  function setup(): void {
    const docHeight = document.documentElement.scrollHeight;
    for (const pct of depths) {
      const el = document.createElement('div');
      el.dataset.sd = String(pct);
      const top = pct < 100 ? Math.round(docHeight * pct / 100) : docHeight - 2;
      el.style.cssText = `position:absolute;top:${top}px;left:0;width:1px;height:1px;pointer-events:none;z-index:-1;`;
      document.body.appendChild(el);
      scrollSentinels.push(el);
      scrollObserver?.observe(el);
    }
  }

  if (document.readyState === 'complete') {
    setup();
  } else {
    window.addEventListener('load', setup, { once: true });
  }
}

// --- Time on page ---------------------------------------------------------
// pageStart marks the beginning of the *current visible period*, not the
// whole page lifetime — reset whenever the page becomes visible again (or
// navigates in an SPA) so tab-switching reports the actual time spent
// looking at the page instead of cumulative time since load.
let pageStart = Date.now();

function reportTiming(): void {
  const seconds = Math.round((Date.now() - pageStart) / 1000);
  if (seconds > 0 && seconds < 3600) {
    send('timing', { props: { seconds: String(seconds) } });
  }
  pageStart = Date.now();
}

function resetTiming(): void {
  pageStart = Date.now();
}

// --- SPA navigation ---------------------------------------------------------
let historyPatched = false;
let lastPath = '';

function patchHistoryMethod(method: 'pushState' | 'replaceState'): void {
  const original = history[method];
  history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
    const result = original.apply(this, args);
    onLocationChange();
    return result;
  } as typeof history[typeof method];
}

function onLocationChange(): void {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;

  resetTiming();
  if (scrollDepthEnabled) {
    teardownScrollDepth();
    initScrollDepth();
  }
  // SPA navigations have no browser-supplied referrer for the new "page" —
  // the worker maps a missing referrer to 'direct' rather than misreporting
  // the site's own previous page as an external referrer.
  send('pageview', {}, { noReferrer: true });
}

function initSpaTracking(): void {
  if (historyPatched) return;
  historyPatched = true;
  lastPath = location.pathname;
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');
  window.addEventListener('popstate', onLocationChange);
}

/** Initialize Flarelytics with your worker endpoint */
export function init(workerEndpoint: string, options: InitOptions = {}): void {
  endpoint = workerEndpoint.replace(/\/$/, '');
  emitCanonical = options.emitCanonical === true;
  allowLocalhost = options.allowLocalhost === true;
  scrollDepthEnabled = options.scrollDepth === true;

  // Auto-track pageview
  send('pageview');

  // Auto-track outbound link clicks (click = left/keyboard activation,
  // auxclick = middle-click, which opens a new tab without a `click` event)
  document.addEventListener('click', handleOutboundClick);
  document.addEventListener('auxclick', handleOutboundClick);

  // Auto-track time on page: reset the clock whenever the page becomes
  // visible again so repeated tab-switching doesn't inflate AVG(double2).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      reportTiming();
    } else {
      resetTiming();
    }
  });
  // bfcache restores (and regular unloads) don't always fire visibilitychange
  // first — pagehide is the reliable last chance to flush the current period.
  window.addEventListener('pagehide', reportTiming);

  if (scrollDepthEnabled) initScrollDepth();
  if (options.noSpa !== true) initSpaTracking();
}

/** Track a custom event */
export function track(event: string, options: TrackOptions = {}): void {
  send(event, {
    path: options.path || location.pathname,
    ...(options.props ? { props: options.props } : {}),
    ...(typeof options.value === 'number' ? { value: options.value } : {}),
  });
}

// Auto-init from script tag:
// <script data-endpoint="..." data-scroll-depth data-emit-canonical="true"
//         data-allow-localhost data-no-spa src="tracker.js"></script>
if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const dataset = script?.dataset ?? {};
  const ep = dataset.endpoint || defaultEndpoint();
  if (ep) {
    init(ep, {
      scrollDepth: 'scrollDepth' in dataset,
      emitCanonical: dataset.emitCanonical === 'true',
      allowLocalhost: 'allowLocalhost' in dataset,
      noSpa: 'noSpa' in dataset,
    });
  }
}

// Expose global API
if (typeof window !== 'undefined') {
  (window as any).flarelytics = { init, track };
}
