// Typed fetch wrapper for the analytics worker. Every dashboard query used
// to swallow every failure (network error, 401, 403, 500) into `null`,
// which rendered identically to genuinely empty data — a viewer whose
// session expired mid-visit, or whose org lost access to a site, saw
// silent "No data" with no indication they needed to sign in again.
//
// fetchJson distinguishes the two failure classes the UI must react to
// differently:
//   - AuthError (401/403): the session is invalid, or the requested site
//     is not authorized for the active org. The dashboard must show the
//     login gate / a "session expired" banner, never treat this as data.
//   - QueryError (anything else — 500s, malformed JSON, network failure):
//     a genuine query failure, safe to degrade to an empty-data state.

export class AuthError extends Error {
  status: number;

  constructor(status: number) {
    super(status === 403 ? 'forbidden' : 'unauthorized');
    this.name = 'AuthError';
    this.status = status;
  }
}

export class QueryError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'QueryError';
    this.status = status;
  }
}

export interface FetchJsonOptions extends RequestInit {
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { fetchImpl = fetch, ...init } = options;
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'include', ...init });
  } catch {
    throw new QueryError('Could not reach the worker.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(res.status);
  }
  if (!res.ok) {
    throw new QueryError('Request failed with status ' + res.status, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new QueryError('Received an invalid response.');
  }
}

// Builds a `/query` URL: q, period, site plus any `filter[key]=value` pairs
// and extra params (e.g. page, event_name).
export function buildQueryUrl(
  base: string,
  q: string,
  params: { period?: string; site: string; filters?: Record<string, string>; extra?: Record<string, string> }
): string {
  const usp = new URLSearchParams();
  usp.set('q', q);
  if (params.period) usp.set('period', params.period);
  usp.set('site', params.site);
  if (params.extra) {
    for (const [k, v] of Object.entries(params.extra)) usp.set(k, v);
  }
  let qs = base + '/query?' + usp.toString();
  if (params.filters) {
    for (const [k, v] of Object.entries(params.filters)) {
      qs += '&filter%5B' + k + '%5D=' + encodeURIComponent(v);
    }
  }
  return qs;
}
