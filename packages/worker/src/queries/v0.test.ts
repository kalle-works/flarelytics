import { describe, it, expect } from 'vitest';
import { QUERY_TEMPLATES, PERIOD_MAP, FILTER_BLOB, injectFilters } from './v0';

// Fixed fixtures for every template call — none contain characters (quotes)
// that would need escaping, since real callers validate site/page/event_name
// against strict regexes before ever reaching .sql(). What we're guarding
// here is that every template (a) scopes each dataset scan to the site
// (the anchor injectFilters depends on), (b) actually reads from the given
// dataset, (c) plugs in the period param unless it's a live query, and
// (d) fully interpolates its placeholders (no leftover ${...}, no unbalanced
// quoting).
const FIXTURE_DATASET = 'fixture_dataset';
const FIXTURE_SITE = 'fixture-site.example';
const FIXTURE_EVENT = 'fixture_event';
const FIXTURE_PAGE = '/fixture/page';
const FIXTURE_PERIOD = PERIOD_MAP['30d'];

describe('QUERY_TEMPLATES (table-driven)', () => {
  for (const [name, template] of Object.entries(QUERY_TEMPLATES)) {
    describe(name, () => {
      const sql = template.sql(FIXTURE_DATASET, FIXTURE_PERIOD, FIXTURE_SITE, FIXTURE_EVENT, FIXTURE_PAGE);
      const fromCount = (sql.match(new RegExp(`FROM ${FIXTURE_DATASET}\\b`, 'g')) || []).length;
      const anchorCount = (sql.match(new RegExp(`AND blob10 = '${FIXTURE_SITE}'`, 'g')) || []).length;

      it('reads from the given dataset', () => {
        expect(fromCount).toBeGreaterThan(0);
      });

      it('scopes every dataset scan to the site with exactly one anchor per FROM <dataset> (injectFilters needs this)', () => {
        expect(anchorCount).toBe(fromCount);
      });

      if (template.live) {
        it('is a live query and ignores the period param (hardcoded short interval instead)', () => {
          expect(sql).not.toContain(FIXTURE_PERIOD);
        });
      } else {
        it('uses the period param', () => {
          expect(sql).toContain(FIXTURE_PERIOD);
        });
      }

      it('contains no unescaped raw input: every placeholder interpolated, quoting stays balanced', () => {
        expect(sql).not.toContain('${');
        const quoteCount = (sql.match(/'/g) || []).length;
        expect(quoteCount % 2).toBe(0);
      });

      it('injectFilters inserts a filter clause after every site anchor', () => {
        const filterClause = "AND blob3 = 'FI'";
        const withFilter = injectFilters(sql, filterClause);
        const inserted = withFilter.split(filterClause).length - 1;
        expect(anchorCount).toBeGreaterThan(0);
        expect(inserted).toBe(anchorCount);
      });
    });
  }
});

describe('FILTER_BLOB maps every filter key to its documented Analytics Engine blob', () => {
  it('matches the schema documented in CLAUDE.md exactly', () => {
    expect(FILTER_BLOB).toEqual({
      country: 'blob3',
      referrer: 'blob2',
      page: 'blob1',
      device: 'blob11',
      browser: 'blob12',
      os: 'blob13',
      utm_source: 'blob6',
      utm_campaign: 'blob8',
    });
  });
});
