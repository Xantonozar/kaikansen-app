import { describe, expect, it } from '@jest/globals';
import {
  mergeSearchPage,
  searchResultKeys,
  SEARCH_PAGE_SIZE,
} from './searchPaging';

describe('mergeSearchPage', () => {
  const bySlug = (t: { slug: string }): string => t.slug;

  it('appends a fresh page in order', () => {
    const merged = mergeSearchPage(
      [{ slug: 'a' }, { slug: 'b' }],
      [{ slug: 'c' }],
      bySlug,
    );
    expect(merged.map((t) => t.slug)).toEqual(['a', 'b', 'c']);
  });

  it('drops rows whose key is already present (no duplicates, stable order)', () => {
    const merged = mergeSearchPage(
      [{ slug: 'a' }, { slug: 'b' }],
      [{ slug: 'b' }, { slug: 'c' }, { slug: 'a' }],
      bySlug,
    );
    expect(merged.map((t) => t.slug)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes within the incoming page itself', () => {
    const merged = mergeSearchPage([], [{ slug: 'x' }, { slug: 'x' }], bySlug);
    expect(merged).toHaveLength(1);
  });

  it('does not mutate the existing array', () => {
    const existing = [{ slug: 'a' }];
    const merged = mergeSearchPage(existing, [{ slug: 'b' }], bySlug);
    expect(existing).toHaveLength(1);
    expect(merged).not.toBe(existing);
  });
});

describe('searchResultKeys', () => {
  it('keys each group by its identity field', () => {
    expect(searchResultKeys.themes({ slug: 'naruto-op1' } as never)).toBe(
      'naruto-op1',
    );
    expect(searchResultKeys.anime({ anilistId: 42 } as never)).toBe('42');
    expect(searchResultKeys.artists({ slug: 'lisa' } as never)).toBe('lisa');
    expect(searchResultKeys.users({ username: 'zadid' } as never)).toBe(
      'zadid',
    );
  });

  it('pages full views at 15 (the Option B lazy-load size)', () => {
    expect(SEARCH_PAGE_SIZE).toBe(15);
  });
});
