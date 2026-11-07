import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Bookmark,
  ChevronLeft,
  Eye,
  Headphones,
  Layers,
  Mic,
  Play,
  Plus,
  Share2,
  Star,
} from 'lucide-react-native';
import type { ThemeDetail } from '@kaikansen/contracts';
import { fetchThemeBySlug } from '../../../src/api';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/**
 * Theme detail (DESIGN.md §6.7, read-path scope), compact/icon-led
 * treatment (approved mockup v1): the artwork leads full-bleed with
 * glass icon buttons overlaid (back; bookmark + share — visual only,
 * no save/share behaviour exists in this slice) and an accent play
 * FAB straddling its bottom edge. Below: song title, one meta line
 * (anime · artist), the chips, ONE labelled action pill (Watch) with
 * icon squares beside it (Listen; Add — visual only like Watch), a
 * fact card of icon-led rows (artist / rating / watches / listens /
 * versions), and version tiles drawn from the real entries when
 * there is more than one. Playback itself, the rating widget,
 * comments and downloads arrive in later slices — the actions are
 * visual in this slice, as before.
 */
export default function ThemeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [detail, setDetail] = useState<ThemeDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    'loading',
  );

  useEffect(() => {
    let live = true;
    setState('loading');
    fetchThemeBySlug(slug)
      .then((data) => {
        if (!live) return;
        if (data) {
          setDetail(data);
          setState('ready');
        } else {
          setState('missing');
        }
      })
      .catch(() => {
        if (live) setState('error');
      });
    return () => {
      live = false;
    };
  }, [slug]);

  /** Rounded-square back button; `glass` floats it over the artwork. */
  const backTile = (glass: boolean) => (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.backHit}
    >
      <View style={[styles.tile, glass ? styles.tileGlass : styles.tileSolid]}>
        <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  /** Visual-only glass action over the artwork (no behaviour this slice). */
  const glassAction = (Icon: IconComponent, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.backHit,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.tile, styles.tileGlass]}>
        <Icon size={19} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile(false)}
        </View>
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      </View>
    );
  }

  if (state !== 'ready' || !detail) {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile(false)}
        </View>
        <View style={styles.center}>
          <Text style={styles.message}>
            {state === 'missing'
              ? 'That theme could not be found.'
              : 'Could not load this theme.'}
          </Text>
        </View>
      </View>
    );
  }

  const cover = detail.animeGrillImage ?? detail.animeCoverImage;
  const artists = detail.artistName ?? detail.allArtists.join(', ') ?? '';
  const chips: string[] = [`${detail.type} ${detail.sequence}`];
  if (detail.animeSeason && detail.animeSeasonYear) {
    chips.push(`${detail.animeSeason} ${detail.animeSeasonYear}`);
  }
  for (const mood of detail.mood) chips.push(mood);

  const factRow = (
    Icon: IconComponent,
    label: string,
    value: string,
    last: boolean,
  ) => (
    <View style={[styles.factRow, last && styles.factRowLast]}>
      <Icon size={16} color={theme.muted} strokeWidth={2} />
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );

  const hasMultipleVersions = detail.entries.length > 1;

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        <View style={styles.artWrap}>
          {cover ? (
            <Image source={{ uri: cover }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder]} />
          )}
          <View
            style={[styles.overlay, { top: insets.top + spacing.sm }]}
          >
            {backTile(true)}
            <View style={styles.overlayActions}>
              {glassAction(Bookmark, 'Save theme')}
              {glassAction(Share2, 'Share theme')}
            </View>
          </View>
          {/* Visual only in this slice — playback lands with the player. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Play"
            style={({ pressed }) => [
              styles.fab,
              pressed && styles.pressed,
            ]}
          >
            <Play size={24} color={theme.onAccent} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <Text style={styles.song}>{detail.songTitle}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {detail.animeTitle}
            {artists.length > 0 ? ` · ${artists}` : ''}
          </Text>

          <View style={styles.chipRow}>
            {chips.map((chip, i) => (
              <View
                key={`${chip}-${i}`}
                style={[
                  styles.chip,
                  i === 0 && {
                    backgroundColor:
                      detail.type === 'ED' ? theme.tertiary : theme.accent,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    i === 0 && { color: theme.onAccent },
                  ]}
                >
                  {chip}
                </Text>
              </View>
            ))}
          </View>

          {/* Visual only in this slice — playback lands with the player. */}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Watch"
              style={({ pressed }) => [
                styles.watchButton,
                pressed && styles.pressed,
              ]}
            >
              <Play size={19} color={theme.onAccent} strokeWidth={2} />
              <Text style={styles.watchText}>Watch</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Listen"
              style={({ pressed }) => [
                styles.squareAction,
                pressed && styles.pressed,
              ]}
            >
              <Headphones size={20} color={theme.text} strokeWidth={2} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to library"
              style={({ pressed }) => [
                styles.squareAction,
                pressed && styles.pressed,
              ]}
            >
              <Plus size={20} color={theme.text} strokeWidth={2} />
            </Pressable>
          </View>

          <View style={styles.factCard}>
            {artists.length > 0 &&
              factRow(Mic, 'Artist', artists, false)}
            {factRow(
              Star,
              'Rating',
              `${detail.avgRating.toFixed(1)} · ${detail.totalRatings}`,
              false,
            )}
            {factRow(Eye, 'Watches', `${detail.totalWatches}`, false)}
            {factRow(
              Headphones,
              'Listens',
              `${detail.totalListens}`,
              !hasMultipleVersions,
            )}
            {hasMultipleVersions &&
              factRow(
                Layers,
                'Versions',
                `${detail.entries.length}`,
                true,
              )}
          </View>

          {hasMultipleVersions && (
            <View style={styles.versionRow}>
              {detail.entries.map((entry, i) => (
                <View
                  key={`${entry.atEntryId}-${i}`}
                  style={[
                    styles.versionTile,
                    i === 0 && styles.versionTileActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.versionText,
                      i === 0 && styles.versionTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {entry.version}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.background,
  },
  column: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  topRow: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.sm,
  },
  backHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileSolid: {
    backgroundColor: theme.raised,
  },
  tileGlass: {
    // Translucent fill stands in for backdrop blur (no blur dependency
    // in this slice); both are derived from the active token set.
    backgroundColor: withOpacity(theme.background, 0.62),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: withOpacity(theme.text, 0.14),
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  message: {
    ...typeStyles.body,
    color: theme.muted,
    textAlign: 'center',
  },
  artWrap: {
    position: 'relative',
  },
  cover: {
    width: '100%',
    aspectRatio: 3 / 2,
    backgroundColor: theme.surface,
  },
  coverPlaceholder: {
    backgroundColor: theme.raised,
  },
  overlay: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 5,
  },
  overlayActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  fab: {
    position: 'absolute',
    right: spacing.screenEdge,
    bottom: -26,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.accent,
    borderWidth: 4,
    borderColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
    elevation: 6,
  },
  body: {
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.xl + 6, // clears the straddling FAB
    paddingBottom: spacing.xxxl,
  },
  song: {
    ...typeStyles.display,
    fontSize: 24,
    color: theme.text,
  },
  meta: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: spacing.xs + 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    backgroundColor: theme.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  chipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  watchButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: theme.accent,
    borderRadius: 14,
    minHeight: 46,
  },
  watchText: {
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  squareAction: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
  },
  factCard: {
    marginTop: spacing.lg,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  factRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  factRowLast: {
    borderBottomWidth: 0,
  },
  factLabel: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  factValue: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    marginLeft: 'auto',
    flexShrink: 1,
    textAlign: 'right',
  },
  versionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  versionTile: {
    flex: 1,
    backgroundColor: theme.raised,
    borderRadius: radii.base,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
  },
  versionTileActive: {
    backgroundColor: withOpacity(theme.accent, 0.16),
  },
  versionText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  versionTextActive: {
    color: theme.onAccentContainer,
  },
});
