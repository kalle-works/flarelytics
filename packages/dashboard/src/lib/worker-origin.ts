/**
 * The dashboard accepts a `?worker=` override so a self-hosted worker can be
 * pointed at from the hosted dashboard. The value ends up in fetch URLs and
 * in `location.href` for the login redirect, so it must be an http(s)
 * origin: a `javascript:` or `data:` value would run in the dashboard's
 * origin when the login button is clicked.
 */
export function resolveWorkerOrigin(param: string | null, fallback: string): string {
  const candidate = (param || '').trim();
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return url.origin;
      }
    } catch {
      /* fall through to the configured default */
    }
  }
  return (fallback || '').replace(/\/$/, '');
}
