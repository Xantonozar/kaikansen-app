import { describe, expect, it } from '@jest/globals';
import {
  anilistCoverForSlot,
  avatarUrlUsable,
  cloudinarySized,
  isRenderableImageUrl,
  themeCoverForSlot,
} from './imageVariants';

/**
 * Slot → variant selection (perf problem 11). The theme cover
 * pair: animeCoverImage = LARGE (AT large / AniList
 * coverImage.large), animeCoverImageSmall = the row variant
 * (AT small / AniList coverImage.medium) — same cover, two
 * sizes, per the sync/enrichment provenance.
 */
describe('themeCoverForSlot', () => {
  const both = {
    animeCoverImage: 'https://s4.anilist.co/large.jpg',
    animeCoverImageSmall: 'https://s4.anilist.co/medium.jpg',
  };

  it('rows, thumbs and cards get the SMALL variant', () => {
    expect(themeCoverForSlot(both, 'row')).toBe(
      'https://s4.anilist.co/medium.jpg',
    );
    expect(themeCoverForSlot(both, 'thumb')).toBe(
      'https://s4.anilist.co/medium.jpg',
    );
    expect(themeCoverForSlot(both, 'card')).toBe(
      'https://s4.anilist.co/medium.jpg',
    );
  });

  it('heroes get the LARGE variant', () => {
    expect(themeCoverForSlot(both, 'hero')).toBe(
      'https://s4.anilist.co/large.jpg',
    );
  });

  it('falls back to the other variant when the preferred one is missing', () => {
    expect(
      themeCoverForSlot(
        { animeCoverImage: 'https://x/large.jpg', animeCoverImageSmall: null },
        'row',
      ),
    ).toBe('https://x/large.jpg');
    expect(
      themeCoverForSlot(
        { animeCoverImage: null, animeCoverImageSmall: 'https://x/small.jpg' },
        'hero',
      ),
    ).toBe('https://x/small.jpg');
    expect(
      themeCoverForSlot(
        { animeCoverImage: null, animeCoverImageSmall: null },
        'row',
      ),
    ).toBeNull();
  });
});

describe('anilistCoverForSlot', () => {
  const pair = {
    coverImageLarge: 'https://s4.anilist.co/file/large.jpg',
    coverImageMedium: 'https://s4.anilist.co/file/medium.jpg',
  };

  it('medium for rows, large only for heroes', () => {
    expect(anilistCoverForSlot(pair, 'row')).toBe(pair.coverImageMedium);
    expect(anilistCoverForSlot(pair, 'thumb')).toBe(pair.coverImageMedium);
    expect(anilistCoverForSlot(pair, 'hero')).toBe(pair.coverImageLarge);
  });

  it('falls back across the pair', () => {
    expect(
      anilistCoverForSlot(
        { coverImageLarge: null, coverImageMedium: 'm.jpg' },
        'hero',
      ),
    ).toBe('m.jpg');
    expect(
      anilistCoverForSlot(
        { coverImageLarge: 'l.jpg', coverImageMedium: null },
        'row',
      ),
    ).toBe('l.jpg');
  });
});

describe('cloudinarySized', () => {
  it('inserts the width transform ahead of the version segment', () => {
    expect(
      cloudinarySized(
        'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-01_n0q719.png',
        120,
      ),
    ).toBe(
      'https://res.cloudinary.com/chirkut/image/upload/w_120,c_limit/v1794261844/avatar-01_n0q719.png',
    );
  });

  it('works without a version segment (rank icons style paths too)', () => {
    expect(
      cloudinarySized(
        'https://res.cloudinary.com/chirkut/image/upload/kaikansen/ranks/rank-01.webp',
        96,
      ),
    ).toBe(
      'https://res.cloudinary.com/chirkut/image/upload/w_96,c_limit/kaikansen/ranks/rank-01.webp',
    );
  });

  it('never rewrites third-party hosts', () => {
    const anilist = 'https://s4.anilist.co/file/medium.jpg';
    expect(cloudinarySized(anilist, 120)).toBe(anilist);
    const dicebear = 'https://api.dicebear.com/7.x/adventurer/svg?seed=x';
    expect(cloudinarySized(dicebear, 120)).toBe(dicebear);
  });

  it('leaves an already-transformed URL alone', () => {
    const done =
      'https://res.cloudinary.com/chirkut/image/upload/w_80,c_limit/v1/a.png';
    expect(cloudinarySized(done, 120)).toBe(done);
  });
});

/**
 * The Avatar fallback chain's usability test (audit-fix 7/8):
 * DiceBear SVGs are NOT renderable (path-segment format), raster
 * URLs are, and a URL that already failed on the surface drops
 * out of the chain — keyed by the exact URL.
 */
describe('avatar chain usability', () => {
  it('rejects null and empty', () => {
    expect(isRenderableImageUrl(null)).toBe(false);
    expect(isRenderableImageUrl('')).toBe(false);
  });

  it('rejects DiceBear SVG path-segment URLs, query and all', () => {
    expect(
      isRenderableImageUrl(
        'https://api.dicebear.com/7.x/adventurer/svg?seed=Zadid',
      ),
    ).toBe(false);
    expect(
      isRenderableImageUrl('https://api.dicebear.com/9.x/personas/svg'),
    ).toBe(false);
  });

  it('rejects .svg file URLs', () => {
    expect(isRenderableImageUrl('https://example.com/a/avatar.svg')).toBe(
      false,
    );
    expect(
      isRenderableImageUrl('https://example.com/a/avatar.SVG?x=1'),
    ).toBe(false);
  });

  it('accepts raster URLs, including ones with svg in a query value', () => {
    expect(
      isRenderableImageUrl('https://res.cloudinary.com/chirkut/a.png'),
    ).toBe(true);
    expect(isRenderableImageUrl('https://example.com/pic.jpg?next=.svg')).toBe(
      true,
    );
  });

  it('a failed URL leaves the chain; a different URL is tried fresh', () => {
    const url = 'https://example.com/dead.png';
    expect(avatarUrlUsable(url, null)).toBe(true);
    expect(avatarUrlUsable(url, url)).toBe(false);
    expect(avatarUrlUsable('https://example.com/new.png', url)).toBe(true);
    expect(avatarUrlUsable(null, null)).toBe(false);
  });
});
