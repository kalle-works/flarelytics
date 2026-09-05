// Pure row -> table/chart mappers. These turn worker `/query` responses
// (attacker-influenced: page paths, referrers, UTM values, custom event
// properties all originate from POST /track, which the tracker or an
// X-API-Key server-side caller can set to arbitrary strings) into HTML
// fragments and chart series. Every value that reaches innerHTML goes
// through esc(); nothing here ever builds an inline event-handler
// attribute (onclick="...") from row data — see renderTopPageRowHtml /
// renderTopStoryRowHtml, which is the fix for the stored-XSS finding.
import { esc } from './escape';
import { num, fmtCurrency, chartDateLabel } from './format';

export type Row = Record<string, unknown>;
export type QueryResponse = Row[] | { data?: Row[] } | null | undefined;

export function rows(d: QueryResponse): Row[] {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray((d as { data?: Row[] }).data)) return (d as { data: Row[] }).data;
  return [];
}

export function sum(arr: Row[], field: string): number {
  return arr.reduce((acc, r) => acc + (parseFloat(String(r[field])) || 0), 0);
}

// Splits a "|"-separated custom-event properties string into its parts,
// e.g. blob5 "click|/pricing" -> ["click", "/pricing"].
export function parsePropsList(raw: unknown): string[] {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return [];
  return s
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// A `share` custom event's properties are positional: part[0] is the share
// action/platform, part[1] is the shared URL. Returns the pathname of that
// URL, or null if it's missing/unparseable.
export function parseShareTargetPath(propertiesRaw: unknown): string | null {
  const raw = propertiesRaw == null ? '' : String(propertiesRaw);
  const parts = raw.split('|');
  const rawUrl = parts[1] || '';
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return null;
  }
}

// Aggregates share counts per page path from the custom-events rows, for
// the "Jaot" (shares) column on the Top Pages table.
export function buildShareMap(eventRows: Row[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of eventRows) {
    if (row.event !== 'share' || !row.properties) continue;
    const path = parseShareTargetPath(row.properties);
    if (!path) continue;
    map[path] = (map[path] || 0) + (parseFloat(String(row.count)) || 1);
  }
  return map;
}

// Week-over-week comparison: sorts by date, splits into two halves, and
// compares the summed value field between them.
export function computeWow(allRows: Row[], valueField: string): number | null {
  if (!allRows.length) return null;
  const sorted = [...allRows].sort((a, b) => (String(a.date ?? '') < String(b.date ?? '') ? -1 : 1));
  const half = Math.floor(sorted.length / 2);
  if (half === 0) return null;
  const prev = sorted.slice(0, half);
  const curr = sorted.slice(sorted.length - half);
  const prevSum = sum(prev, valueField);
  const currSum = sum(curr, valueField);
  if (prevSum === 0) return null;
  return ((currSum - prevSum) / prevSum) * 100;
}

export interface ChartSeries {
  labels: string[];
  data: number[];
}

export function toChartSeries(r: Row[], dateField: string, valueField: string): ChartSeries {
  return {
    labels: r.map((d) => chartDateLabel(d[dateField])),
    data: r.map((d) => parseFloat(String(d[valueField])) || 0),
  };
}

export interface ColumnSpec {
  key: string;
  align?: 'left' | 'right';
  fmt?: 'num' | 'currency' | 'pct' | 'props';
  filter?: string;
  favicon?: boolean;
}

export function computeMaxVals(allRows: Row[], cols: ColumnSpec[]): Record<string, number> {
  const maxVals: Record<string, number> = {};
  for (const c of cols) {
    if (c.fmt === 'num') {
      maxVals[c.key] = allRows.reduce((max, row) => Math.max(max, parseFloat(String(row[c.key])) || 0), 0);
    }
  }
  return maxVals;
}

// Generic table row renderer shared by every `<table class="tbl">` in the
// dashboard. Filterable cells carry data-filter-key/data-filter-val
// attributes (read by a single delegated click listener) rather than an
// inline onclick — safe because attribute-context HTML escaping (esc())
// is sufficient there, unlike inside a onclick="...js..." string.
export function renderTableRowsHtml(r: Row[], cols: ColumnSpec[], maxVals: Record<string, number>): string {
  let html = '';
  r.forEach((row) => {
    html += '<tr>';
    cols.forEach((c) => {
      const v = row[c.key];
      const align = c.align || 'left';
      const styleAttr = 'text-align:' + align;
      const filterAttrs = c.filter
        ? ' class="filterable" data-filter-key="' + esc(c.filter) + '" data-filter-val="' + esc(String(v == null ? '' : v)) + '"'
        : '';

      if (c.favicon) {
        const rawVal = v == null ? '' : String(v);
        const faviconUrl = 'https://www.google.com/s2/favicons?sz=16&domain=' + esc(rawVal);
        html +=
          '<td' + filterAttrs + ' style="font-family:var(--mono);font-size:0.8125rem;">' +
          '<span style="display:flex;align-items:center;gap:0.375rem;">' +
          '<img src="' + faviconUrl + '" width="16" height="16" style="border-radius:2px;flex-shrink:0;" data-fallback-hide="true">' +
          esc(rawVal) +
          '</span></td>';
      } else if (c.fmt === 'num') {
        const rawNum = parseFloat(String(row[c.key])) || 0;
        const pct = maxVals[c.key] > 0 ? (rawNum / maxVals[c.key]) * 100 : 0;
        const bg = 'background:linear-gradient(to right,rgba(217,119,6,0.15) ' + pct + '%,transparent ' + pct + '%)';
        html += '<td' + filterAttrs + ' style="' + styleAttr + ';' + bg + '">' + num(v) + '</td>';
      } else if (c.fmt === 'currency') {
        html +=
          '<td' + filterAttrs + ' style="' + styleAttr + ';font-family:var(--mono);font-variant-numeric:tabular-nums;">' +
          fmtCurrency(parseFloat(String(v)) || 0) +
          '</td>';
      } else if (c.fmt === 'pct') {
        html += '<td' + filterAttrs + ' style="' + styleAttr + '">' + (parseFloat(String(v)) || 0).toFixed(1) + '%</td>';
      } else if (c.fmt === 'props') {
        const rawStr = v == null ? '' : String(v).trim();
        if (!rawStr) {
          html += '<td style="' + styleAttr + '">-</td>';
        } else {
          const tags = parsePropsList(rawStr)
            .map(
              (p) =>
                '<span style="display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:11px;color:var(--ink-secondary);margin:1px 2px 1px 0;">' +
                esc(p) +
                '</span>'
            )
            .join('');
          html += '<td style="' + styleAttr + '">' + tags + '</td>';
        }
      } else {
        html += '<td' + filterAttrs + ' style="' + styleAttr + '">' + (esc(v) || '-') + '</td>';
      }
    });
    html += '</tr>';
  });
  return html;
}

export interface TopPageRow {
  path?: unknown;
  views?: unknown;
  visitors?: unknown;
}

// Top Pages / Top Articles row builder. `shares` is null when the shares
// column isn't shown at all. The path is only ever placed in a data-path
// attribute (attribute-context escaping via esc()) — never concatenated
// into an onclick handler, which is what let a path like
// "');alert(1);('" execute arbitrary JS in the previous implementation.
export function renderTopPageRowHtml(row: TopPageRow, shares: number | null): string {
  const rawPath = row.path == null ? '' : String(row.path);
  const path = esc(rawPath) || '-';
  const views = num(row.views);
  const visitors = num(row.visitors);
  let html =
    '<tr class="drilldown-row" style="cursor:pointer;" data-path="' + esc(rawPath) + '">' +
    '<td style="text-align:left;">' + path + '</td>' +
    '<td style="text-align:right;">' + views + '</td>' +
    '<td style="text-align:right;">' + visitors + '</td>';
  if (shares != null) {
    html += '<td style="text-align:right;">' + (shares > 0 ? num(shares) : '-') + '</td>';
  }
  html += '</tr>';
  return html;
}

export function renderTopStoryRowHtml(row: TopPageRow, pct: number): string {
  const rawPath = row.path == null ? '' : String(row.path);
  return (
    '<tr class="drilldown-row" style="cursor:pointer;" data-path="' + esc(rawPath) + '">' +
    '<td style="text-align:left;">' + (esc(rawPath) || '-') + '</td>' +
    '<td style="text-align:right;">' + num(row.views) + '</td>' +
    '<td style="text-align:right;">' + num(row.visitors) + '</td>' +
    '<td style="width:80px;padding-right:12px;"><div style="background:var(--surface);border-radius:4px;overflow:hidden;height:6px;"><div style="background:var(--accent);height:100%;width:' + pct + '%;border-radius:4px;"></div></div></td>' +
    '</tr>'
  );
}
