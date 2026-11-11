import { describe, expect, it } from '@jest/globals';
import type { SearchResponse } from '@kaikansen/contracts';
import {
  SEARCH_MEMORY_CAPACITY,
  SearchMemory,
  planSearch,
} from './searchMemory';

/**
 * Search session memory (speed batch, Option B): the LRU seam
 * (put/get/evict, exact-query keying) and the render decision
 * (hit → instant render + background refresh; miss → network
 * path). Pure logic only — the screen's wiring rides on these.
 */

function response(tag: string): SearchResponse {
  return { tag } as unknown as SearchResponse;
}

describe('SearchMemory (LRU)', () => {
  it('put → get returns the remembered response', () => {
    const memory = new SearchMemory();
    const res = response('naruto');
    memory.put('naruto', res);
    expect(memory.get('naruto')).toBe(res);
    expect(memory.size).toBe(1);
  });

  it('keying is the EXACT query string — near-misses miss', () => {
    const memory = new SearchMemory();
    memory.put('naruto', response('naruto'));
    expect(memory.get('naru')).toBeUndefined();
    expect(memory.get('Naruto')).toBeUndefined();
    expect(memory.get('naruto ')).toBeUndefined();
    expect(memory.get('')).toBeUndefined();
  });

  it('re-putting a query replaces its entry (no growth)', () => {
    const memory = new SearchMemory();
    memory.put('a', response('a1'));
    memory.put('a', response('a2'));
    expect(memory.size).toBe(1);
    expect(memory.get('a')).toEqual(response('a2'));
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const memory = new SearchMemory(3);
    memory.put('a', response('a'));
    memory.put('b', response('b'));
    memory.put('c', response('c'));
    memory.put('d', response('d'));
    expect(memory.size).toBe(3);
    expect(memory.get('a')).toBeUndefined();
    expect(memory.get('d')).toBeDefined();
  });

  it('a get counts as use — recently-read entries survive eviction', () => {
    const memory = new SearchMemory(3);
    memory.put('a', response('a'));
    memory.put('b', response('b'));
    memory.put('c', response('c'));
    expect(memory.get('a')).toBeDefined(); // 'a' is now most-recent
    memory.put('d', response('d')); // evicts 'b', the true LRU
    expect(memory.get('a')).toBeDefined();
    expect(memory.get('b')).toBeUndefined();
    expect(memory.get('c')).toBeDefined();
  });

  it('the default capacity is the spec’s ~10', () => {
    const memory = new SearchMemory();
    for (let i = 0; i < SEARCH_MEMORY_CAPACITY + 5; i += 1) {
      memory.put(`q${i}`, response(`q${i}`));
    }
    expect(SEARCH_MEMORY_CAPACITY).toBe(10);
    expect(memory.size).toBe(10);
    expect(memory.get('q0')).toBeUndefined();
    expect(memory.get('q14')).toBeDefined();
  });

  it('clear empties the memory', () => {
    const memory = new SearchMemory();
    memory.put('a', response('a'));
    memory.clear();
    expect(memory.size).toBe(0);
    expect(memory.get('a')).toBeUndefined();
  });
});

describe('planSearch (the render decision)', () => {
  it('a hit renders immediately AND still refreshes in background', () => {
    const memory = new SearchMemory();
    const res = response('naruto');
    memory.put('naruto', res);
    const plan = planSearch(memory, 'naruto');
    expect(plan.immediate).toBe(res);
    expect(plan.refreshInBackground).toBe(true);
    expect(plan.fromMemory).toBe(true);
  });

  it('a miss has nothing to render and is NOT from memory', () => {
    const memory = new SearchMemory();
    const plan = planSearch(memory, 'unknown');
    expect(plan.immediate).toBeNull();
    expect(plan.refreshInBackground).toBe(true);
    expect(plan.fromMemory).toBe(false);
  });
});
