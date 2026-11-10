import { describe, expect, it } from '@jest/globals';
import { resolveOpenThemesAs } from './playbackSettings';

/**
 * The Theme Detail open-mode setting (playback plan decision 2):
 * unset — and anything unrecognised — resolves to Listen; only
 * an explicit saved 'watch' opens on the Watch side.
 */
describe('resolveOpenThemesAs', () => {
  it('defaults to listen when unset', () => {
    expect(resolveOpenThemesAs(null)).toBe('listen');
    expect(resolveOpenThemesAs(undefined)).toBe('listen');
  });

  it('honours a saved watch, and falls back to listen on garbage', () => {
    expect(resolveOpenThemesAs('watch')).toBe('watch');
    expect(resolveOpenThemesAs('listen')).toBe('listen');
    expect(resolveOpenThemesAs('something-else')).toBe('listen');
  });
});
