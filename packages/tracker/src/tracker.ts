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

/** Initialize Flarelytics with your worker endpoint */
export function init(workerEndpoint: string): void {
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
}

/** Track a custom event */
export function track(event: string, options: TrackOptions = {}): void {
  send(event, {
    path: options.path || location.pathname,
    ...(options.props ? { props: options.props } : {}),
  });
}

// Auto-init from script tag: <script data-endpoint="..." src="tracker.js"></script>
if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const ep = script?.dataset?.endpoint;
  if (ep) init(ep);
}

// Expose global API
if (typeof window !== 'undefined') {
  (window as any).flarelytics = { init, track };
}
