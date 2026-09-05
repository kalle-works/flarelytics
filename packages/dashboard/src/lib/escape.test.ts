import { describe, it, expect } from 'vitest';
import { esc } from './escape';

describe('esc', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  it('returns an empty string for null/undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('stringifies non-string input before escaping', () => {
    expect(esc(42)).toBe('42');
  });

  it('neutralizes an attribute-breakout payload', () => {
    // The XSS regression payload from the audit: a page path designed to
    // close out of an onclick="openDrilldown('...')" attribute.
    expect(esc(`');alert(1);('`)).toBe('&#39;);alert(1);(&#39;');
  });
});
