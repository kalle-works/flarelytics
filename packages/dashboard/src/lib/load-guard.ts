// Request-generation guard against the race condition where rapid
// period/site switches fire overlapping loadAll() batches and a stale
// response (from a superseded load) overwrites a newer one.
//
// Usage: call next() at the start of each load; capture the returned
// generation; before applying a batch's results, check isCurrent(gen) —
// if it's false, a newer load has started and this batch's results must
// be discarded.
export interface LoadGuard {
  next(): number;
  isCurrent(generation: number): boolean;
}

export function createLoadGuard(): LoadGuard {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    isCurrent(gen: number): boolean {
      return gen === generation;
    },
  };
}
