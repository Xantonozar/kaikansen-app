import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppImage } from './AppImage';
import { themeCoverForSlot } from '../imageVariants';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { usePosterCardWidth } from '../layout';

/**
 * Season poster card — originated as a port of the website's
 * ThemeFeaturedCard (kaisen-src/app/components/theme/ThemeFeaturedCard.tsx):
 * portrait art at radius cardLg, originally with a bottom gradient
 * scrim and the song title in white inside the art.
 *
 * Proportions follow the Lavender Dusk Home mock, not the web card:
 * measured from kaikansen-home-v3-realimg.png the mock's cards are
 * ≈315×427px of the 780px-wide render — ≈40% window width (see
 * usePosterCardWidth) at a ≈0.74 width/height aspect, where the web
 * port's 2/3 read too tall (owner's design pass). The rail renders
 * them at 1.3× that size (owner's order, 2026-11-10 — the factor
 * lives in usePosterCardWidth).
 *
 * OWNER RULING 2026-11-11 ("remove this shadow dark boxes thing
 * from seasonal", title placement = Option A): the stacked-strip
 * scrim and the in-art white title are GONE — that supersedes the
 * old "web scrim parity" note. The art now stands clean, and the
 * song title sits BELOW the art in the app's standard ink text
 * (PopularCard's title treatment: display font, 15pt, theme.text),
 * two lines max. Everything reads the active theme tokens.
 * Used only by the Home season rail.
 *
 * The in-art season/type chip ("SUMMER '26 OP", layout-fidelity
 * Slice 6) was removed on the owner's order (2026-11-10): the rail
 * already sits under the season's section header, so printing the
 * season and type on every card was redundant.
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
  // Portrait card art is a card/hero slot: the LARGE cover
  // variant (perf problem 11 — themeCoverForSlot 'hero').
  const cover = themeCoverForSlot(item, 'hero');

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
          <AppImage source={cover} style={styles.image} recyclingKey={item.slug} />
        ) : (
          <View style={[styles.image, styles.placeholder]} />
        )}
      </View>
      <Text style={styles.song} numberOfLines={2}>
        {item.songTitle}
      </Text>
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
  song: {
    fontFamily: fontFamilies.display,
    fontSize: 15,
    color: theme.text,
    marginTop: spacing.sm,
  },
});
