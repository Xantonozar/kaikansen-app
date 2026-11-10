import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { fontFamilies, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { pickDefaultAvatar } from '../defaultAvatars';

/**
 * User avatar (Slice M5) — the shared circle for feed rows, comments,
 * profiles and notifications. Three cases:
 * - A raster avatar URL renders as the stored image, as before.
 * - NO avatar (null/empty URL): the user's deterministic bundled
 *   chibi (see defaultAvatars.ts) fills the circle instead of the
 *   old initial-letter disc. `seed` picks the chibi — callers pass
 *   the user id where they have it, else the username; with no seed
 *   the display `name` is hashed.
 * - An SVG URL (DiceBear fallbacks are SVG, which React Native's
 *   Image cannot draw) ALSO gets the deterministic chibi (owner
 *   decision 2026-11-09): in the app there is no renderable stored
 *   avatar to show, so the chibi stands in — on the web the same
 *   user's DiceBear still renders normally. DiceBear carries the
 *   format as a PATH segment (`.../7.x/adventurer/svg?seed=...`),
 *   never as a '.svg' substring — the usability test below checks
 *   the path ending, not a substring (the substring version let
 *   every DiceBear URL through to Image and rendered blank,
 *   owner-reported on the Social/Home activity feeds 2026-11-10).
 * `disableDefaultAvatar` opts a non-user borrower (the artist hero)
 * out of the chibi and back to the initial disc — for every
 * unusable-avatar case above.
 *
 * A raster URL that FAILS TO LOAD (deleted/expired image — audit
 * S5) joins the unusable cases at runtime: the Image's onError
 * marks that exact URL failed and the render falls through to the
 * same chibi (or initial disc) instead of leaving an empty circle
 * on every surface. The failure is keyed by URL, so a changed
 * avatarUrl is tried fresh.
 */
export function Avatar({
  url,
  name,
  size = 40,
  seed,
  disableDefaultAvatar = false,
}: {
  url: string | null;
  name: string;
  size?: number;
  seed?: string;
  disableDefaultAvatar?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  /** The exact URL whose load failed (see the header note). */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const hasUrl = url !== null && url.length > 0;
  const urlPath = hasUrl ? url.toLowerCase().split(/[?#]/)[0] : '';
  const usable =
    hasUrl &&
    !urlPath.endsWith('.svg') &&
    !urlPath.endsWith('/svg') &&
    failedUrl !== url;
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  const box = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  if (usable) {
    return (
      <Image
        source={{ uri: url }}
        style={[styles.image, box]}
        accessibilityLabel={`${name}'s avatar`}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  if (!usable && !disableDefaultAvatar) {
    return (
      <Image
        source={pickDefaultAvatar(seed ?? name)}
        style={[styles.image, box]}
        accessibilityLabel={`${name}'s avatar`}
      />
    );
  }
  return (
    <View style={[styles.fallback, box]} accessibilityLabel={`${name}'s avatar`}>
      <Text
        style={[
          styles.initial,
          size >= 56 ? styles.initialLarge : null,
        ]}
      >
        {initial}
      </Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    image: {
      backgroundColor: theme.surface,
      flexShrink: 0,
    },
    fallback: {
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    initial: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    initialLarge: {
      fontSize: 24,
    },
  });
