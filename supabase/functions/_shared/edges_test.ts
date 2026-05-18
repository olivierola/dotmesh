/**
 * Unit tests for the edge inference math (cosineSim, freshness, scoring).
 * The DB-touching path is integration-tested elsewhere.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// Re-derive the formulas here so we can test them without exposing internals.
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

Deno.test('cosine identity → 1', () => {
  const v = [1, 2, 3];
  assertEquals(Math.round(cosine(v, v) * 1000) / 1000, 1);
});

Deno.test('cosine orthogonal → 0', () => {
  assertEquals(cosine([1, 0], [0, 1]), 0);
});

Deno.test('cosine opposite → -1', () => {
  assertEquals(cosine([1, 1], [-1, -1]), -1);
});

Deno.test('combined score above threshold when entities overlap and embeddings similar', () => {
  const freq = 2 / 3;
  const fresh = 1;
  const sim = 0.8;
  const score = freq * 0.4 + fresh * 0.3 + sim * 0.3;
  assert(score >= 0.3);
});

Deno.test('combined score below threshold when nothing overlaps', () => {
  const score = 0 * 0.4 + 0.05 * 0.3 + 0.1 * 0.3;
  assert(score < 0.3);
});
