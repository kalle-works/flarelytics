import { describe, it, expect } from 'vitest';
import { csvCell, tableToCsv } from './csv';

describe('csvCell', () => {
  it('neutralises formula triggers at the start of a cell', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-x')).toBe('"\'-x"');
    expect(csvCell('@cmd')).toBe('"\'@cmd"');
  });

  it('leaves ordinary paths and numbers untouched apart from quoting', () => {
    expect(csvCell('/pricing')).toBe('"/pricing"');
    expect(csvCell(1234)).toBe('"1234"');
    expect(csvCell(null)).toBe('""');
  });

  it('joins rows with commas and newlines', () => {
    expect(tableToCsv([['a', 'b'], ['c', '=d']])).toBe('"a","b"\n"c","\'=d"');
  });
});
