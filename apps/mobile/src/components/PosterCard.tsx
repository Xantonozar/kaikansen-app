import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { usePosterCardWidth } from '../layout';

/**
 * Season poster card — ported from the website's ThemeFeaturedCard
 * (kaisen-src/app/components/theme/ThemeFeaturedCard.tsx): 2/3 portrait
 * art at radius cardLg, a bottom gradient scrim, and inside the art a
 * type-only chip ("OP" / "ED", on a dark pill — the rail's section
 * heading already names the season) above the song title in white. No
 * below-art text: the web carries the title in-art, so the old top
 * "SEASON YEAR" sticker and the below-art song/anime block are gone.
 *
 * The scrim + chip + white title are artwork-legibility treatment, not
 * theme surfaces: the web applies the identical black scrim and white
 * text in both of its themes, so they are fixed here too (stacked
 * translucent strips stand in for the web's CSS gradient — no gradient
 * library in the app). Everything else reads the active theme tokens.
 * Used only by the Home season rail.
 *
 * The Lavender Dusk Home mock draws the chip WITH the season
 * ("SPRING '26 OP"): the caller passes that full label as
 * `chipLabel` (layout-fidelity Slice 6); without it the chip falls
 * back to the web's type-only form.
 */
export function PosterCard({
  item,
  onPress,
  chipLabel,
}: {
  item: ThemeSummary;
  onPress?: () => void;
  chipLabel?: string;
}) {
  const theme = useTheme();
  const width = usePosterCardWidth();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImage ?? item.animeCoverImageSmall;
  const chip = chipLabel ?? item.type;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { width },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.art}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.image} />
        ) : (
          <View style={[styles.image, styles.placeholder]} />
        )}
        {/* Bottom gradient scrim (web: from-black/90 via-black/40). */}
        <View style={styles.scrim} pointerEvents="none">
          <View style={[styles.scrimStrip, { backgroundColor: 'rgba(0,0,0,0.08)' }]} />
          <View style={[styles.scrimStrip, { backgroundColor: 'rgba(0,0,0,0.28)' }]} />
          <View style={[styles.scrimStrip, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          <View style={[styles.scrimStrip, { backgroundColor: 'rgba(0,0,0,0.72)' }]} />
          <View style={[styles.scrimStrip, { backgroundColor: 'rgba(0,0,0,0.88)' }]} />
        </View>
        <View style={styles.overlay}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{chip}</Text>
          </View>
          <Text style={styles.song} numberOfLines={2}>
            {item.songTitle}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {},
  pressed: {
    opacity: 0.75,
  },
  art: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radii.cardLg,
    overflow: 'hidden',
    backgroundColor: theme.surface,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    backgroundColor: theme.raised,
  },
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '55%',
  },
  scrimStrip: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
  },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  chipText: {
    fontFamily: fontFamilies.display,
    fontSize: 9,
    letterSpacing: 1.4,
    color: '#FFFFFF',
  },
  song: {
    fontFamily: fontFamilies.display,
    fontSize: 15,
    lineHeight: 19,
    color: '#FFFFFF',
  },
});
