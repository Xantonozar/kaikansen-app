import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Per-mode surface invariant (2026-11-11 restructure) — the
 * regression net for the Android video saga, and the record of
 * WHY this shape is the rule.
 *
 * History, in the owner's field reports (2026-11-11):
 * - The batch-4-era structure (perf problem 12) had per-mode
 *   surfaces: DetailWatchHero mounted its own born-visible
 *   surface, DetailListenHero its own hidden one. Watch WORKED.
 * - Today's single-surface fix replaced that with ONE
 *   always-mounted page-level VideoView per screen whose STYLE
 *   flipped 1×1-hidden ↔ 16:9-visible with mode/artwork/W2.
 *   Two builds shipped it, two field reports indicted it:
 *   1.0.0 — Watch played audio only, never a frame (0:00);
 *   1.0.1 — real frames for ~3s, then the player died into the
 *   audio fallback ("The video could not be played..."). The
 *   owner: "It was running well before these updates today.
 *   And now audio running well."
 * - On Android (TextureView), a player bound to a view that
 *   begins life 1×1/opacity-0 — or is restyled/resized after
 *   attach — can lose its video output while the audio proceeds:
 *   exactly both reports. The pre-fix watch surface never went
 *   through a hidden phase.
 *
 * The restored rule, pinned by these source scans:
 * - Theme Detail: the PAGE binds no surface at all; the WATCH
 *   hero binds two surface ELEMENTS in different branches (the
 *   born-visible watch surface + the W2 hidden one — one mounts
 *   per state); the LISTEN hero binds ONE hidden surface (the
 *   untouchable fallback's).
 * - No surface element is ever restyled between its hidden and
 *   visible forms: the watch element's style is a plain in-flow
 *   style, never a conditional flip; the hidden elements' style
 *   never contains the visible stage style.
 * - Player route: exactly ONE surface ELEMENT, remounted keyed
 *   by MODE (born in its mode's form — visible watch form or
 *   hidden listen form, never restyled between them).
 * - Mode switches survive the rebinding through the engine's
 *   discipline (usePlayback): unmount detaches (pause first —
 *   never playing while unbound) and a watch resume waits for
 *   the NEW surface's first frame via the surface-readiness
 *   gate. Those behaviours are pinned in mediaEngine.test.ts /
 *   detailPlayer.test.ts; this file pins the SURFACE SHAPE.
 *
 * A surface element is counted as a JSX open tag: "<VideoView"
 * followed by whitespace (its attributes follow). Type
 * references such as useRef<VideoView> are followed by ">" and
 * are not surfaces, so they never count.
 *
 * The polish batch's honest-progress + font-scaling guards are
 * pinned by the same scan pattern (polishGuards below): the fake
 * fills and the unguarded chip labels were one-line regressions
 * waiting to happen, so the source itself carries the pin.
 */

const read = (relative: string): string =>
  readFileSync(join(__dirname, relative), 'utf8');

const surfaceCount = (source: string): number =>
  (source.match(/<VideoView\s/g) ?? []).length;

/** The JSX block of the VideoView element carrying `marker`. */
const surfaceBlock = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.lastIndexOf('<VideoView', start);
  expect(open).toBeGreaterThanOrEqual(0);
  const close = source.indexOf('/>', start);
  expect(close).toBeGreaterThan(start);
  return source.slice(open, close);
};

describe('per-mode video surfaces — source invariant (2026-11-11 restructure)', () => {
  const detailPage = read('../app/(drawer)/theme/[slug].tsx');
  const watchHero = read('components/DetailWatchHero.tsx');
  const listenHero = read('components/DetailListenHero.tsx');
  const playerRoute = read('../app/(drawer)/player.tsx');

  it('the theme detail page binds NO surface (the heroes own them)', () => {
    expect(surfaceCount(detailPage)).toBe(0);
  });

  it('the watch hero binds the born-visible watch surface + the W2 hidden one', () => {
    expect(surfaceCount(watchHero)).toBe(2);
  });

  it('the listen hero binds exactly one surface — the fallback’s hidden one', () => {
    expect(surfaceCount(listenHero)).toBe(1);
  });

  it('per mode exactly one detail surface mounts (3 elements across the heroes, 1 per state)', () => {
    // Watch state: the visible watch surface (or its W2 hidden
    // twin after the degradation). Listen state: the listen
    // hero's hidden surface. Artwork state: none. The count
    // that matters at runtime is 1 per mode — the element count
    // here is the source shape that guarantees it.
    expect(
      surfaceCount(watchHero) + surfaceCount(listenHero),
    ).toBe(3);
  });

  it('the watch surface is born visible: plain in-flow style, first-frame wiring, no flip', () => {
    const block = surfaceBlock(watchHero, 'surfaceType="textureView"');
    // The style is the in-flow 16:9 stage style — NOT a
    // conditional (no ternary, no hidden style anywhere near it).
    expect(block).toContain('style={styles.heroVideo}');
    expect(block).not.toContain('?');
    expect(block).not.toContain('hiddenSurface');
    expect(block).toContain('onFirstFrameRender');
    // The W2 surface is a SEPARATE element with the hidden style.
    const w2 = surfaceBlock(watchHero, 'styles.hiddenSurface');
    expect(w2).not.toContain('heroVideo');
    expect(w2).not.toContain('onFirstFrameRender');
  });

  it('the listen surface is born hidden and never gated', () => {
    const block = surfaceBlock(listenHero, 'playback.surfacePlayer');
    expect(block).toContain('styles.hiddenSurface');
    expect(block).not.toContain('onFirstFrameRender');
    expect(block).not.toContain('heroVideo');
  });

  it('player route binds exactly one surface element, remounted keyed by mode', () => {
    expect(surfaceCount(playerRoute)).toBe(1);
    expect(playerRoute).toContain('key={mode}');
    // The element's style is chosen by the mode ternary between
    // its two born forms — never a flip driven by playback
    // state (fallback/buffering/artwork), which is the
    // indicted pattern.
    const block = surfaceBlock(playerRoute, 'key={mode}');
    expect(block).toContain('mode ===');
    expect(block).not.toContain('audioFallback');
    expect(block).not.toContain('surfaceVisible');
  });

  it('no screen carries the indicted single-surface flip machinery', () => {
    for (const source of [detailPage, watchHero, listenHero, playerRoute]) {
      expect(source).not.toContain('heroSurfaceHidden');
      expect(source).not.toContain('detailSurfaceVisible');
    }
    expect(detailPage).not.toContain('styles.heroSurface');
  });
});

describe('polish batch guards — source pins (2026-11-11)', () => {
  const home = read('../app/(drawer)/(tabs)/index.tsx');
  const downloads = read('../app/(drawer)/downloads.tsx');
  const library = read('../app/(drawer)/(tabs)/library.tsx');

  it('continue listening draws no fake progress fill', () => {
    expect(home).not.toContain('continueProgressFill');
    expect(home).not.toContain("width: '0%'");
  });

  it('downloads never fills an indeterminate bar with a fake percent', () => {
    // No static percent literal may drive a width anywhere in
    // the file — the fill's width comes only from the computed
    // pct (downloadFillPercent); layout widths are numbers or
    // the typed '100%' constant (never a fake partial fill).
    expect(downloads).not.toMatch(/width: '(?!100%')\d+%'|width: "(?!100%")\d+%"/);
    expect(downloads).toContain('downloadFillPercent');
  });

  it('library segment chip labels opt out of font scaling', () => {
    expect(library).toContain('allowFontScaling={false}');
  });
});
