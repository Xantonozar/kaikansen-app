import { describe, expect, it } from '@jest/globals';
import {
  APP_IMAGE_TRANSITION_MS,
  appImageProps,
  contentFitForResizeMode,
} from './appImageMapping';

/**
 * Shared AppImage props mapping (perf problem 11): the exact
 * expo-image props every artwork render in the app receives —
 * memory-disk caching, the Lavender-Dusk tint as the loading
 * background, the short cross-dissolve, and recyclingKey /
 * onError / accessibility pass-through.
 */
describe('appImageProps', () => {
  it('maps a URI source with the locked defaults', () => {
    const mapped = appImageProps({
      source: { uri: 'https://s4.anilist.co/medium.jpg' },
      style: { width: 48, height: 48 },
      placeholderColor: '#EDE3F2',
    });
    expect(mapped.source).toEqual({ uri: 'https://s4.anilist.co/medium.jpg' });
    expect(mapped.contentFit).toBe('cover');
    expect(mapped.transition).toBe(APP_IMAGE_TRANSITION_MS);
    expect(mapped.cachePolicy).toBe('memory-disk');
    // The tint rides as the leading backgroundColor layer so the
    // box shows Lavender Dusk lavender while the art loads.
    expect(mapped.style).toEqual([
      { backgroundColor: '#EDE3F2' },
      { width: 48, height: 48 },
    ]);
  });

  it("a call site's own backgroundColor wins over the tint", () => {
    const style = { width: 10, backgroundColor: '#FFFEFF' };
    const mapped = appImageProps({
      source: { uri: 'https://x/y.jpg' },
      style,
      placeholderColor: '#EDE3F2',
    });
    expect(mapped.style).toBe(style);
  });

  it('passes bundled-asset sources, fit, recyclingKey and handlers through', () => {
    const onError = () => {};
    const mapped = appImageProps({
      source: 42,
      contentFit: 'contain',
      placeholderColor: '#EDE3F2',
      recyclingKey: 'theme:abc',
      accessibilityLabel: 'Cover',
      onError,
    });
    expect(mapped.source).toBe(42);
    expect(mapped.contentFit).toBe('contain');
    expect(mapped.recyclingKey).toBe('theme:abc');
    expect(mapped.accessibilityLabel).toBe('Cover');
    expect(mapped.onError).toBe(onError);
  });
});

describe('contentFitForResizeMode', () => {
  it("maps RN resizeMode names ('center' → 'none', default 'cover')", () => {
    expect(contentFitForResizeMode('cover')).toBe('cover');
    expect(contentFitForResizeMode('contain')).toBe('contain');
    expect(contentFitForResizeMode('fill')).toBe('fill');
    expect(contentFitForResizeMode('center')).toBe('none');
    expect(contentFitForResizeMode(undefined)).toBe('cover');
  });
});
