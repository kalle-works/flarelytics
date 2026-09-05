// Reads/writes the dashboard's shareable state (active site + period) to
// and from the page URL, so a refresh or a shared link restores the same
// view instead of always resetting to the first site's 7-day window.
export const VALID_PERIODS = ['7d', '30d', '90d'] as const;
export type Period = (typeof VALID_PERIODS)[number];

export function isValidPeriod(value: string | null): value is Period {
  return !!value && (VALID_PERIODS as readonly string[]).includes(value);
}

export interface UrlState {
  site: string | null;
  period: Period | null;
}

export function parseUrlState(search: string): UrlState {
  const usp = new URLSearchParams(search);
  const site = usp.get('site');
  const periodRaw = usp.get('period');
  return {
    site: site && site.trim() ? site : null,
    period: isValidPeriod(periodRaw) ? periodRaw : null,
  };
}

// Merges `site`/`period` into an existing search string, leaving every
// other param (e.g. `worker`) untouched.
export function withUrlState(search: string, state: { site?: string | null; period?: string | null }): string {
  const usp = new URLSearchParams(search);
  if (state.site) usp.set('site', state.site);
  if (state.period) usp.set('period', state.period);
  const qs = usp.toString();
  return qs ? '?' + qs : '';
}
