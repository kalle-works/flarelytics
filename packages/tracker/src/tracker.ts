/**
 * Flarelytics Tracker — lightweight client-side analytics (<1KB gzipped)
 *
 * Usage (script tag):
 *   <script defer data-endpoint="https://your-worker.workers.dev" src="/tracker.js"></script>
 *
 * Usage (npm):
 *   import { init, track } from '@flarelytics/tracker'
 *   init('https://your-worker.workers.dev')
 *   track('signup', { plan: 'pro' })
 */

let endpoint = '';

interface TrackOptions {
  props?: Record<string, string>;
  path?: string;
}

export interface InitOptions {
  /** Track scroll depth at 25/50/75/100% milestones using IntersectionObserver */
  scrollDepth?: boolean;
}

function send(event: string, data: Record<string, unknown> = {}): void {
  if (!endpoint) return;

  const payload: Record<string, unknown> = {
    event,
    path: data.path || location.pathname,
    ...data,
  };

  // Add referrer for pageviews
  if (event === 'pageview') {
    const ref = document.referrer;
    if (ref) {
      try { payload.referrer = new URL(ref).hostname; }
      catch { payload.referrer = ref; }
    } else {
      payload.referrer = 'direct';
    }

    // UTM params
    const params = new URLSearchParams(location.search);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const val = params.get(key);
      if (val) payload[key] = val;
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

function initScrollDepth(): void {
  if (!('IntersectionObserver' in window)) return;

  const fired = new Set<number>();
  const depths = [25, 50, 75, 100];

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const depth = parseInt((entry.target as HTMLElement).dataset.sd || '0', 10);
      if (depth && !fired.has(depth)) {
        fired.add(depth);
        send('scroll_depth', { props: { depth: String(depth) } });
        if (fired.size === depths.length) observer.disconnect();
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
      observer.observe(el);
    }
  }

  if (document.readyState === 'complete') {
    setup();
  } else {
    window.addEventListener('load', setup, { once: true });
  }
}

/** Initialize Flarelytics with your worker endpoint */
export function init(workerEndpoint: string, options: InitOptions = {}): void {
  endpoint = workerEndpoint.replace(/\/$/, '');

  // Auto-track pageview
  send('pageview');

  // Auto-track outbound link clicks
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    try {
      const url = new URL(anchor.href);
      if (url.hostname === location.hostname) return;
      send('outbound', { props: { url: url.hostname + url.pathname } });
    } catch {}
  });

  if (options.scrollDepth) initScrollDepth();
}

/** Track a custom event */
export function track(event: string, options: TrackOptions = {}): void {
  send(event, {
    path: options.path || location.pathname,
    ...(options.props ? { props: options.props } : {}),
  });
}

// Auto-init from script tag: <script data-endpoint="..." data-scroll-depth src="tracker.js"></script>
if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const ep = script?.dataset?.endpoint;
  if (ep) {
    init(ep, {
      scrollDepth: 'scrollDepth' in (script?.dataset ?? {}),
    });
  }
}

// Expose global API
if (typeof window !== 'undefined') {
  (window as any).flarelytics = { init, track };
}
