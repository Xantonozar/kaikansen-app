import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Single-surface invariant (2026-11-11 fix) — the regression net
 * for the Android video-dead bug. expo-video binds ONE player to
 * ONE VideoView; Theme Detail used to move the shared
 * surfacePlayer between the listen hero's hidden surface and the
 * watch hero's visible one across mode switches (and the player
 * route swapped two surfaces on its mode toggle), which left the
 * player permanently video-dead: audio played, no frames ever
 * rendered. These source scans pin the cure:
 * - the theme detail page binds exactly ONE surface element;
 * - the two detail heroes bind NONE (they are chrome only);
 * - the player route binds exactly ONE.
 *
 * A surface element is counted as a JSX open tag: "<VideoView"
 * followed by whitespace (its attributes follow). Type
 * references such as useRef<VideoView> are followed by ">" and
 * are not surfaces, so they never count.
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

const surfaceCount = (source: string): number =>
  (source.match(/<VideoView\s/g) ?? []).length;

describe('single-owner video surface — source invariant', () => {
  const detailPage = read('../app/(drawer)/theme/[slug].tsx');
  const watchHero = read('components/DetailWatchHero.tsx');
  const listenHero = read('components/DetailListenHero.tsx');
  const playerRoute = read('../app/(drawer)/player.tsx');

  it('theme detail page binds exactly one surface', () => {
    expect(surfaceCount(detailPage)).toBe(1);
  });

  it('the detail heroes bind no surface at all', () => {
    expect(surfaceCount(watchHero)).toBe(0);
    expect(surfaceCount(listenHero)).toBe(0);
    // Not even a mention: the heroes render chrome only, so the
    // surface binding can never creep back into a hero.
    expect(watchHero).not.toContain('VideoView');
    expect(listenHero).not.toContain('VideoView');
  });

  it('the whole detail screen tree binds exactly one surface', () => {
    expect(
      surfaceCount(detailPage) +
        surfaceCount(watchHero) +
        surfaceCount(listenHero),
    ).toBe(1);
  });

  it('player route binds exactly one surface', () => {
    expect(surfaceCount(playerRoute)).toBe(1);
  });
});
