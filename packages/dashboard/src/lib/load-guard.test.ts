import { describe, it, expect } from 'vitest';
import { createLoadGuard } from './load-guard';

describe('createLoadGuard', () => {
  it('reports the most recent generation as current', () => {
    const guard = createLoadGuard();
    const gen = guard.next();
    expect(guard.isCurrent(gen)).toBe(true);
  });

  it('marks a superseded generation as stale once a newer load starts', () => {
    const guard = createLoadGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('simulates out-of-order resolution: only the latest load applies its results', () => {
    const guard = createLoadGuard();
    const genA = guard.next(); // period=7d fired first
    const genB = guard.next(); // period=30d fired second, resolves first
    const applied: string[] = [];

    // 30d resolves first
    if (guard.isCurrent(genB)) applied.push('30d');
    // 7d resolves later, but is now stale
    if (guard.isCurrent(genA)) applied.push('7d');

    expect(applied).toEqual(['30d']);
  });
});
