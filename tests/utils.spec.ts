import { describe, it, expect } from 'vitest';
import { zip5, isLikelyPersonName, splitPersonNames, parseNumber } from '../src/lib/utils';

describe('utils', () => {
  it('zip5 should extract 5-digit zips', () => {
    expect(zip5('78756-1234')).toBe('78756');
    expect(zip5('abc')).toBeNull();
  });

  it('isLikelyPersonName detects person names', () => {
    expect(isLikelyPersonName('John Smith')).toBe(true);
    expect(isLikelyPersonName('ACME LLC')).toBe(false);
  });

  it('splitPersonNames splits owners', () => {
    const r = splitPersonNames('Smith, John & Doe, Jane');
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].first).toBe('John');
    expect(r[1].first).toBe('Jane');
  });

  it('parseNumber handles currency strings', () => {
    expect(parseNumber('$1,234.00')).toBeCloseTo(1234);
    expect(parseNumber(null)).toBe(0);
  });
});
