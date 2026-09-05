// HTML-entity escaping for values interpolated into innerHTML strings.
// Every render helper in lib/rows.ts and the dashboard's inline script must
// run untrusted data (page paths, referrers, UTM params — all attacker
// controlled via POST /track) through this before it reaches the DOM.
const ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (m) => ENTITY_MAP[m]);
}
