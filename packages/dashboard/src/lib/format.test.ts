import { describe, it, expect } from 'vitest';
import { num, fmtCurrency, fmtSeconds, fmtPercentChange, chartDateLabel } from './format';

describe('num', () => {
  it('rounds and thousands-separates', () => {
    expect(num(1234.6)).toBe('1,235');
  });

  it('treats null/undefined/NaN as zero', () => {
    expect(num(null)).toBe('0');
    expect(num(undefined)).toBe('0');
    expect(num(NaN)).toBe('0');
    expect(num('not-a-number')).toBe('0');
  });

  it('parses numeric strings', () => {
    expect(num('42')).toBe('42');
  });
});

describe('fmtCurrency', () => {
  it('renders zero without a currency symbol as plain 0.00', () => {
    expect(fmtCurrency(0)).toBe('0.00');
  });

  it('does not render negative zero as "-0.00"', () => {
    expect(fmtCurrency(-0)).toBe('0.00');
  });

  it('renders two decimal places with thousands separators', () => {
    expect(fmtCurrency(1234.5)).toBe('1,234.50');
  });
});

describe('fmtSeconds', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(fmtSeconds(45)).toBe('45s');
  });

  it('renders minute+second durations', () => {
    expect(fmtSeconds(125)).toBe('2m 5s');
  });
});

describe('fmtPercentChange', () => {
  it('prefixes positive changes with a plus sign', () => {
    expect(fmtPercentChange(12.34)).toBe('+12.3%');
  });

  it('does not double up the minus sign for negative changes', () => {
    expect(fmtPercentChange(-4.5)).toBe('-4.5%');
  });

  it('returns null when there is nothing to compare', () => {
    expect(fmtPercentChange(null)).toBeNull();
  });

  it('prefixes exactly-zero change with a plus sign (unchanged, not negative)', () => {
    expect(fmtPercentChange(0)).toBe('+0.0%');
  });
});

describe('chartDateLabel', () => {
  it('truncates an ISO date to MM-DD', () => {
    expect(chartDateLabel('2026-09-05')).toBe('09-05');
  });

  it('handles missing dates', () => {
    expect(chartDateLabel(undefined)).toBe('');
  });
});
