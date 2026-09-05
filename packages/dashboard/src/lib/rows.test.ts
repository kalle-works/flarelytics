import { describe, it, expect } from 'vitest';
import {
  rows,
  sum,
  parsePropsList,
  parseShareTargetPath,
  buildShareMap,
  computeWow,
  toChartSeries,
  computeMaxVals,
  renderTableRowsHtml,
  renderTopPageRowHtml,
  renderTopStoryRowHtml,
} from './rows';

describe('rows', () => {
  it('unwraps the {data:[...]} envelope', () => {
    expect(rows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });

  it('passes a bare array through unchanged', () => {
    expect(rows([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  it('returns [] for null/undefined/malformed responses', () => {
    expect(rows(null)).toEqual([]);
    expect(rows(undefined)).toEqual([]);
    expect(rows({} as never)).toEqual([]);
  });
});

describe('sum', () => {
  it('sums a numeric field across rows, treating unparsable values as 0', () => {
    expect(sum([{ v: '3' }, { v: 4 }, { v: 'x' }], 'v')).toBe(7);
  });
});

describe('parsePropsList', () => {
  it('splits pipe-separated properties and trims whitespace', () => {
    expect(parsePropsList(' click | /pricing ')).toEqual(['click', '/pricing']);
  });

  it('drops empty segments', () => {
    expect(parsePropsList('a||b')).toEqual(['a', 'b']);
  });

  it('returns [] for empty/missing input', () => {
    expect(parsePropsList('')).toEqual([]);
    expect(parsePropsList(null)).toEqual([]);
  });
});

describe('parseShareTargetPath', () => {
  it('extracts the pathname from the second positional field', () => {
    expect(parseShareTargetPath('bluesky|https://example.com/a/my-article')).toBe('/a/my-article');
  });

  it('returns null when the URL field is missing or invalid', () => {
    expect(parseShareTargetPath('bluesky')).toBeNull();
    expect(parseShareTargetPath('bluesky|not-a-url')).toBeNull();
  });
});

describe('buildShareMap', () => {
  it('aggregates share counts by target path, ignoring non-share events', () => {
    const map = buildShareMap([
      { event: 'share', properties: 'bluesky|https://x.com/a/foo', count: '2' },
      { event: 'share', properties: 'x|https://x.com/a/foo', count: '1' },
      { event: 'click', properties: 'bluesky|https://x.com/a/foo', count: '5' },
    ]);
    expect(map).toEqual({ '/a/foo': 3 });
  });
});

describe('computeWow', () => {
  it('returns null with no rows', () => {
    expect(computeWow([], 'views')).toBeNull();
  });

  it('computes a positive percentage change between the two halves', () => {
    const r = [
      { date: '2026-01-01', views: 10 },
      { date: '2026-01-02', views: 10 },
      { date: '2026-01-03', views: 20 },
      { date: '2026-01-04', views: 20 },
    ];
    expect(computeWow(r, 'views')).toBe(100);
  });
});

describe('toChartSeries', () => {
  it('maps rows to date-truncated labels and numeric data', () => {
    const series = toChartSeries([{ date: '2026-09-05', views: '12' }], 'date', 'views');
    expect(series).toEqual({ labels: ['09-05'], data: [12] });
  });
});

describe('computeMaxVals', () => {
  it('finds the max only for num-formatted columns', () => {
    const cols = [{ key: 'views', fmt: 'num' as const }, { key: 'path' }];
    const max = computeMaxVals([{ views: 3 }, { views: 9 }], cols);
    expect(max).toEqual({ views: 9 });
  });
});

describe('renderTableRowsHtml — filterable cells use data attributes, not onclick', () => {
  it('never emits an onclick attribute for filterable columns', () => {
    const html = renderTableRowsHtml(
      [{ country: `');alert(1);('`, views: 5 }],
      [{ key: 'country', filter: 'country' }, { key: 'views', align: 'right', fmt: 'num' }],
      { views: 5 }
    );
    expect(html).not.toContain('onclick=');
    expect(html).toContain('data-filter-val="&#39;);alert(1);(&#39;"');
  });
});

describe('renderTopPageRowHtml — XSS regression', () => {
  const maliciousPath = `');alert(1);('`;

  it('renders no onclick attribute at all', () => {
    const html = renderTopPageRowHtml({ path: maliciousPath, views: 1, visitors: 1 }, null);
    expect(html).not.toContain('onclick');
  });

  it('places the (escaped) path in a data-path attribute', () => {
    const html = renderTopPageRowHtml({ path: maliciousPath, views: 1, visitors: 1 }, null);
    expect(html).toContain('data-path="&#39;);alert(1);(&#39;"');
  });

  it('does not leak the raw payload anywhere in the markup', () => {
    const html = renderTopPageRowHtml({ path: maliciousPath, views: 1, visitors: 1 }, null);
    expect(html).not.toContain(maliciousPath);
  });

  it('includes the shares column only when shares is non-null', () => {
    const withShares = renderTopPageRowHtml({ path: '/a', views: 1, visitors: 1 }, 3);
    const withoutShares = renderTopPageRowHtml({ path: '/a', views: 1, visitors: 1 }, null);
    expect(withShares).toContain('>3<');
    expect(withoutShares.match(/<td/g)?.length).toBe(3);
    expect(withShares.match(/<td/g)?.length).toBe(4);
  });
});

describe('renderTopStoryRowHtml — XSS regression', () => {
  it('renders no onclick attribute and carries data-path instead', () => {
    const html = renderTopStoryRowHtml({ path: `');alert(1);('`, views: 1, visitors: 1 }, 50);
    expect(html).not.toContain('onclick');
    expect(html).toContain('data-path="&#39;);alert(1);(&#39;"');
  });
});
