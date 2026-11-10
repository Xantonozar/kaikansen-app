import { useMemo } from 'react';
import { Image } from '../expoImage';
import type { ImageStyle } from '../expoImage';
import type { ImageSource as ExpoImageSource } from 'expo-image';
import type { StyleProp } from 'react-native';
import { appImageProps, contentFitForResizeMode } from '../appImageMapping';
import { useTheme } from '../theme-context';

/**
 * AppImage (perf problem 11) — THE shared artwork component.
 * Every cover/artwork render in the app goes through here
 * instead of scattering raw expo-image (or stock RN Image)
 * calls: disk+memory caching, the Lavender-Dusk-tinted loading
 * placeholder (the theme's raised lavender shows while the art
 * loads — the same background the RN styles already painted),
 * and a short 200ms fade-in, all from the pure mapping in
 * appImageMapping.ts (unit-tested). Call sites keep their fixed
 * aspect boxes and their own empty-state Views — this component
 * only ever renders when a source exists.
 *
 * Props mirror the RN Image call sites it replaces: `source`
 * accepts a URI string, an {uri} object, or a bundled asset
 * (require() number); `resizeMode` keeps its RN name and maps
 * to expo-image's contentFit ('center' → 'none'); `recyclingKey`
 * is for list rows (FlatList/SectionList cells) so a recycled
 * cell never flashes the previous row's art.
 *
 * Avatars do NOT come through here — Avatar.tsx is the avatar
 * surface (it carries the fallback chain) and renders expo-image
 * directly; AppHeader's local glyphs and the downloads screen's
 * local-file art likewise stay on their own paths (see the
 * problem-11 report).
 */
export function AppImage({
  source,
  style,
  resizeMode,
  recyclingKey,
  accessibilityLabel,
  onError,
  placeholderColor,
}: {
  source: string | number | ExpoImageSource | ExpoImageSource[];
  style?: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain' | 'fill' | 'center';
  recyclingKey?: string | null;
  accessibilityLabel?: string;
  onError?: () => void;
  /** Override the loading tint (default: the theme's raised lavender). */
  placeholderColor?: string;
}) {
  const theme = useTheme();
  const mapped = useMemo(
    () =>
      appImageProps({
        source: typeof source === 'string' ? { uri: source } : source,
        style,
        contentFit: contentFitForResizeMode(resizeMode),
        placeholderColor: placeholderColor ?? theme.raised,
        recyclingKey,
        accessibilityLabel,
        onError,
      }),
    [source, style, resizeMode, placeholderColor, theme.raised, recyclingKey, accessibilityLabel, onError],
  );
  return <Image {...mapped} />;
}
