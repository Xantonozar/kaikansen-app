import { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { fontFamilies, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * User avatar (Slice M5) — the shared circle for feed rows, comments,
 * profiles and notifications. Renders the stored avatar image when
 * there is a raster URL; otherwise (and for SVG URLs — DiceBear
 * fallbacks are SVG, which React Native's Image cannot draw) it
 * falls back to the initial-on-accent-container treatment the header
 * and drawer already use (P-20).
 */
export function Avatar({
  url,
  name,
  size = 40,
}: {
  url: string | null;
  name: string;
  size?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const usable =
    url !== null && url.length > 0 && !url.toLowerCase().includes('.svg');
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
