import { useMemo, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { LadderRank } from '@kaikansen/contracts';
import { radii, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { ladderInfo } from '../rankUtil';

/**
 * The shared rank-icon tile (app ladder, 2026-11-10): the rank's
 * emblem on the pale-lavender tile every approved rank mock
 * draws (the icons themselves are deep-plum glyphs on #F7F2F7,
 * so the tile reads in both themes). Primary source is the
 * rank's Cloudinary URL; if the remote image errors, the
 * bundled webp from assets/ranks takes over — one component,
 * so every rank surface falls back identically.
 *
 * `dark` renders the tile as the designs' dark cards draw it
 * (the #3D2436 plum card, where the tile stays pale — the
 * emblems are plum-on-pale, so the tile does not invert).
 */
export function RankIcon({
  rank,
  size = 40,
  tileRadius,
}: {
  rank: LadderRank | string;
  size?: number;
  tileRadius?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const info = ladderInfo(rank);
  const [failed, setFailed] = useState(false);

  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: tileRadius ?? Math.round(size * 0.24),
        },
      ]}
      accessibilityLabel={`${info.label} rank icon`}
    >
      <Image
        source={failed ? info.iconAsset : { uri: info.iconUrl }}
        style={{ width: size, height: size }}
        resizeMode="cover"
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    tile: {
      // The final-24 icons are full-bleed pale squares (plum
      // glyph on #F7F2F7); the tile clips them to the mocks'
      // rounded square. The hairline keeps the pale tile
      // legible on a white card.
      backgroundColor: '#F7F2F7',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      // radii.base keeps very small chips from going fully round.
      minWidth: radii.sm,
    },
  });
