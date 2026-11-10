import type { ImageSource as ExpoImageSource } from 'expo-image';
import type { StyleProp } from 'react-native';
import type { ImageStyle } from 'expo-image';

/**
 * Pure props mapping for the shared AppImage component (perf
 * problem 11) — separated from the component so the mapping is
 * unit-testable in the pure-logic Jest suite (no native imports:
 * the expo-image imports above are type-only and erased).
 *
 * The locked treatment (IMAGES-EXPO spec):
 * - cachePolicy 'memory-disk' (expo-image's disk+memory cache).
 * - Lavender-Dusk-tinted placeholder fade-in: the call site's
 *   tint colour is folded into the style as backgroundColor (the
 *   same trick RN Image surfaces already used — their styles set
 *   a theme background behind the art), and a short 200ms
 *   cross-dissolve `transition` fades the loaded image in over
 *   the tint. No layout shift: call sites keep their fixed boxes.
 *   The placeholder shows ONLY while the real image loads — the
 *   "has a URI" vs "no URI" branching stays at call sites, which
 *   keep rendering their own empty-state Views exactly as before.
 * - RN's resizeMode names map 1:1 onto expo-image contentFit
 *   ('cover' | 'contain' | 'fill' | 'center'→'none').
 * - `recyclingKey` passes through where list rows supply one.
 */
export type AppImageFit = 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';

export interface AppImageInput {
  source: string | number | ExpoImageSource | ExpoImageSource[];
  style?: StyleProp<ImageStyle>;
  /** Matches the call site's previous RN resizeMode. Default 'cover'. */
  contentFit?: AppImageFit;
  /**
   * Lavender-Dusk tint colour shown while the image loads. When
   * the call-site style has no backgroundColor of its own, this
   * becomes the image view's backgroundColor; an explicit style
   * backgroundColor always wins.
   */
  placeholderColor: string;
  recyclingKey?: string | null;
  accessibilityLabel?: string;
  onError?: () => void;
}

export interface AppImageMappedProps {
  source: string | number | ExpoImageSource | ExpoImageSource[];
  style?: StyleProp<ImageStyle>;
  contentFit: AppImageFit;
  transition: number;
  cachePolicy: 'memory-disk';
  recyclingKey?: string | null;
  accessibilityLabel?: string;
  onError?: () => void;
}

/** Fade-in duration (ms) — short, per the spec's "short transition". */
export const APP_IMAGE_TRANSITION_MS = 200;

/** RN resizeMode → expo-image contentFit (the names that differ). */
export function contentFitForResizeMode(
  mode: 'cover' | 'contain' | 'fill' | 'center' | undefined,
): AppImageFit {
  if (mode === 'center') return 'none';
  return mode ?? 'cover';
}

export function appImageProps(input: AppImageInput): AppImageMappedProps {
  const style = input.style;
  const hasOwnBackground =
    style !== null &&
    typeof style === 'object' &&
    !Array.isArray(style) &&
    (style as { backgroundColor?: string }).backgroundColor !== undefined;
  return {
    source: input.source,
    style: hasOwnBackground
      ? style
      : [{ backgroundColor: input.placeholderColor }, style],
    contentFit: input.contentFit ?? 'cover',
    transition: APP_IMAGE_TRANSITION_MS,
    cachePolicy: 'memory-disk',
    recyclingKey: input.recyclingKey,
    accessibilityLabel: input.accessibilityLabel,
    onError: input.onError,
  };
}
