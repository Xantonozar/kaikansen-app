import type { SearchResponse } from '@kaikansen/contracts';

/**
 * Search session memory (speed batch, owner ruling 2026-11-11 —
 * Option B) — a small IN-MEMORY LRU of the last successful
 * search result sets, keyed by the exact query string. Search is
 * deliberately NOT in the problem-5 apiCache (search-as-you-type
 * must always be able to fetch fresh); this memory is a separate,
 * narrower thing that lives with the Search screen's session:
 *
 * - a hit lets the screen render the remembered results
 *   IMMEDIATELY while the network fetch still runs in the
 *   background (results can change — themes sync weekly) — the
 *   fresh answer swaps in silently on success;
 * - a background failure keeps the remembered results (no error
 *   state when a memory exists); failures are NEVER remembered,
 *   so a miss that fails still surfaces the error + Retry;
 * - it holds PAGE 1's response only — the full-view paging
 *   state machine (searchPaging merge over group pages) is
 *   untouched and re-fetches its own pages exactly as before.
 *
 * In-memory only by the ruling: a fresh app launch starts empty
 * (NOT AsyncStorage, NOT apiCache). The memory is module-level
 * so it survives the screen unmounting within a session (back
 * out to a theme, return — the memory is still warm), matching
 * how the app's other session stores behave.
 */

export const SEARCH_MEMORY_CAPACITY = 10;

export class SearchMemory {
  /** Map insertion order doubles as the LRU order (oldest first). */
  private entries = new Map<string, SearchResponse>();

  constructor(private readonly capacity: number = SEARCH_MEMORY_CAPACITY) {}

  /** The remembered page-1 response for an exact query, if any. */
  get(query: string): SearchResponse | undefined {
    const hit = this.entries.get(query);
    if (hit === undefined) return undefined;
    // A read is a use: re-insert so eviction takes the truly
    // least-recently-used entry.
    this.entries.delete(query);
    this.entries.set(query, hit);
    return hit;
  }

  /** Remember a SUCCESSFUL result set (callers never put failures). */
  put(query: string, response: SearchResponse): void {
    this.entries.delete(query);
    this.entries.set(query, response);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The session's shared memory (the Search screen's data path). */
export const searchMemory = new SearchMemory();

/**
 * The render decision for a fired search: a memory hit renders
 * the remembered results immediately AND still refreshes in the
 * background; a miss waits on the network (spinner / error path).
 * Kept pure so the decision unit-tests without the screen.
 */
export interface SearchPlan {
  /** Results to render right now (null = nothing yet — spinner). */
  immediate: SearchResponse | null;
  /** The background network fetch ALWAYS runs (freshness). */
  refreshInBackground: boolean;
  /** True when rendering from memory (a refresh failure must NOT
      raise the error state — the remembered results stay). */
  fromMemory: boolean;
}

export function planSearch(
  memory: SearchMemory,
  query: string,
): SearchPlan {
  const hit = memory.get(query);
  if (hit !== undefined) {
    return { immediate: hit, refreshInBackground: true, fromMemory: true };
  }
  return { immediate: null, refreshInBackground: true, fromMemory: false };
}
