// Pure number/currency/duration formatting shared by the KPI cards, tables
// and charts. No DOM access — safe to unit test in isolation.

export function num(n: unknown): string {
  const parsed = typeof n === 'number' ? n : parseFloat(String(n));
  if (n == null || Number.isNaN(parsed)) return '0';
  return Math.round(parsed).toLocaleString('en-US');
}

export function fmtCurrency(n: number): string {
  if (n === 0) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtSeconds(s: number): string {
  const n = Math.round(s);
  if (n < 60) return n + 's';
  return Math.floor(n / 60) + 'm ' + (n % 60) + 's';
}

// Week-over-week style percentage: "+12.3%" / "-4.5%". Returns null when
// there is nothing to compare against, so callers can render a blank badge.
export function fmtPercentChange(pct: number | null): string | null {
  if (pct == null || Number.isNaN(pct)) return null;
  const sign = pct >= 0 ? '+' : '';
  return sign + pct.toFixed(1) + '%';
}

// Truncates an ISO date ("2026-09-05") to a short chart axis label ("09-05").
export function chartDateLabel(date: unknown): string {
  return String(date || '').slice(5);
}
