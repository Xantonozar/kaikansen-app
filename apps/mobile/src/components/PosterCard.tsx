import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { usePosterCardWidth } from '../layout';

/**
 * Season poster card — ported from the website's ThemeFeaturedCard
 * (kaisen-src/app/components/theme/ThemeFeaturedCard.tsx): portrait
 * art at radius cardLg, a bottom gradient scrim, and the song title in
 * white inside the art. No below-art text: the web carries the title
 * in-art, so the old top "SEASON YEAR" sticker and the below-art
 * song/anime block are gone.
 *
 * Proportions follow the Lavender Dusk Home mock, not the web card:
 * measured from kaikansen-home-v3-realimg.png the mock's cards are
 * ≈315×427px of the 780px-wide render — ≈40% window width (see
 * usePosterCardWidth) at a ≈0.74 width/height aspect, where the web
 * port's 2/3 read too tall (owner's design pass). The rail renders
 * them at 1.3× that size (owner's order, 2026-11-10 — the factor
 * lives in usePosterCardWidth).
 *
 * The scrim + white title are artwork-legibility treatment, not
 * theme surfaces: the web applies the identical black scrim and white
 * text in both of its themes, so they are fixed here too (stacked
 * translucent strips stand in for the web's CSS gradient — no gradient
 * library in the app). Everything else reads the active theme tokens.
 * Used only by the Home season rail.
 *
 * The in-art season/type chip ("SUMMER '26 OP", layout-fidelity
 * Slice 6) was removed on the owner's order (2026-11-10): the rail
 * already sits under the season's section header, so printing the
 * season and type on every card was redundant. The title now sits
 * alone in the overlay.
 */
export function PosterCard({
  item,
  onPress,
}: {
  item: ThemeSummary;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const width = usePosterCardWidth();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImage ?? item.animeCoverImageSmall;

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
    // Mock-measured ≈315×427px @2x → ≈0.74 (see the header note).
    aspectRatio: 0.74,
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
  song: {
    fontFamily: fontFamilies.display,
    fontSize: 15,
    lineHeight: 19,
    color: '#FFFFFF',
  },
});
