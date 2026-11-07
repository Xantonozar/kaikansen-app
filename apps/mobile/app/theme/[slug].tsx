import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  Eye,
  Headphones,
  Play,
  Star,
} from 'lucide-react-native';
import type { ThemeDetail } from '@kaikansen/contracts';
import { fetchThemeBySlug } from '../../src/api';
import { radii, spacing, typeStyles, type Theme } from '../../src/theme';
import { useTheme } from '../../src/theme-context';

/**
 * Theme detail (DESIGN.md §6.7, read-path scope): cover header, song and
 * anime titles, artists, season/year/type chips, aggregate rating + watch /
 * listen counts, and the Watch / Listen actions. Playback itself, the
 * rating widget, comments and downloads arrive in later slices — the two
 * buttons are visual in this slice.
 */
export default function ThemeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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

  const back = (
    <Pressable
      onPress={() => router.back()}
      style={styles.back}
      hitSlop={8}
    >
      <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
      <Text style={styles.backText}>Back</Text>
    </Pressable>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {back}
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      </View>
    );
  }

  if (state !== 'ready' || !detail) {
    return (
      <View style={styles.screen}>
        {back}
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
  const artists =
    detail.artistName ?? detail.allArtists.join(', ') ?? '';
  const chips: string[] = [`${detail.type} ${detail.sequence}`];
  if (detail.animeSeason && detail.animeSeasonYear) {
    chips.push(`${detail.animeSeason} ${detail.animeSeasonYear}`);
  }
  for (const mood of detail.mood) chips.push(mood);

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      {back}
      {cover ? (
        <Image source={{ uri: cover }} style={styles.cover} />
      ) : (
        <View style={[styles.cover, styles.coverPlaceholder]} />
      )}

      <View style={styles.body}>
        <Text style={styles.song}>{detail.songTitle}</Text>
        <Text style={styles.anime}>{detail.animeTitle}</Text>
        {artists.length > 0 && <Text style={styles.artist}>{artists}</Text>}

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

        <View style={styles.stats}>
          <View style={styles.stat}>
            <Star size={14} color={theme.muted} strokeWidth={2} />
            <Text style={styles.statText}>
              {detail.avgRating.toFixed(1)} ({detail.totalRatings})
            </Text>
          </View>
          <View style={styles.stat}>
            <Eye size={14} color={theme.muted} strokeWidth={2} />
            <Text style={styles.statText}>{detail.totalWatches} watches</Text>
          </View>
          <View style={styles.stat}>
            <Headphones size={14} color={theme.muted} strokeWidth={2} />
            <Text style={styles.statText}>{detail.totalListens} listens</Text>
          </View>
        </View>

        {/* Visual only in this slice — playback lands with the player slice. */}
        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [
              styles.watchButton,
              pressed && styles.pressed,
            ]}
          >
            <Play size={18} color={theme.onAccent} strokeWidth={2} />
            <Text style={styles.watchText}>Watch</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.listenButton,
              pressed && styles.pressed,
            ]}
          >
            <Headphones size={18} color={theme.text} strokeWidth={2} />
            <Text style={styles.listenText}>Listen</Text>
          </Pressable>
        </View>

        {detail.entries.length > 1 && (
          <Text style={styles.versions}>
            {detail.entries.length} versions available
          </Text>
        )}
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
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  backText: {
    ...typeStyles.body,
    color: theme.text,
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
  cover: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: theme.surface,
  },
  coverPlaceholder: {
    backgroundColor: theme.raised,
  },
  body: {
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  song: {
    ...typeStyles.display,
    color: theme.text,
  },
  anime: {
    ...typeStyles.sectionLabel,
    color: theme.text,
    marginTop: spacing.xs,
  },
  artist: {
    ...typeStyles.body,
    color: theme.muted,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  chip: {
    backgroundColor: theme.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginTop: spacing.xl,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statText: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  watchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: theme.accent,
    borderRadius: radii.base,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  watchText: {
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  listenButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  listenText: {
    ...typeStyles.sectionLabel,
    color: theme.text,
  },
  pressed: {
    opacity: 0.85,
  },
  versions: {
    ...typeStyles.caption,
    color: theme.muted,
    marginTop: spacing.lg,
  },
});
