import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, Search } from 'lucide-react-native';
import type { Season, SeasonResponse, ThemeSummary } from '@kaikansen/contracts';
import { fetchHome, fetchSeason } from '../../src/api';
import { useFavorites } from '../../src/favoritesStore';
import { ThemeRow } from '../../src/components/ThemeRow';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

const SEASON_ORDER: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

/** 'SPRING' → 'Spring' (the mocks title-case season names). */
function seasonTitleCase(season: string): string {
  return season.charAt(0) + season.slice(1).toLowerCase();
}

/**
 * Season browse (DESIGN.md §6.5) — Home's "View All". Layout-
 * fidelity Slice 6 rebuilt it to the design (season.html): back +
 * title-cased season title + a search icon in the header, the
 * four SEASON chips (Winter/Spring/Summer/Fall — the pre-fidelity
 * build's All/OP/ED type filter is not in the design; the
 * endpoint's type parameter stays available server-side), the
 * "N themes this season" count line, then the rows.
 *
 * Data: GET /season (the web's /api/themes/seasonal read, ported
 * in Slice 6) with real pagination (Load more while the server
 * says hasMore). The screen learns which season+year is being
 * served from /home first — the API's fallback-aware current
 * season — and the chips switch season WITHIN that served year:
 * the design has no year switcher, and other years are honestly
 * out of this screen's scope rather than guessed.
 */
export default function SeasonScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const [served, setServed] = useState<{ season: Season; year: number } | null>(
    null,
  );
  const [selected, setSelected] = useState<Season | null>(null);
  const [data, setData] = useState<SeasonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Learn the served season+year from /home (fallback-aware).
  useEffect(() => {
    let live = true;
    fetchHome()
      .then((home) => {
        if (!live) return;
        setServed({ season: home.season.season, year: home.season.year });
        setSelected(home.season.season);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load the season.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // Load page 1 whenever the selected season changes.
  useEffect(() => {
    if (!served || !selected) return;
    let live = true;
    setData(null);
    setError(null);
    fetchSeason(selected, served.year, 1)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load the season.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [served, selected]);

  const loadMore = useCallback(() => {
    if (!served || !selected || !data?.hasMore || loadingMore) return;
    setLoadingMore(true);
    fetchSeason(selected, served.year, data.page + 1)
      .then((res) => {
        setData((prev) =>
          prev
            ? { ...res, themes: [...prev.themes, ...res.themes] }
            : res,
        );
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [served, selected, data, loadingMore]);

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );
  const { startQueue } = usePlaybackSession();
  const playTheme = useCallback(
    (slug: string, list: ThemeSummary[]) => {
      // The shown list is the queue.
      const index = list.findIndex((t) => t.slug === slug);
      if (index >= 0) {
        startQueue(queueItemsFromSummaries(list), index, 'watch');
      }
      router.push({ pathname: '/player', params: { slug, mode: 'watch' } });
    },
    [router, startQueue],
  );

  const themes = data?.themes ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backTile}
        >
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>
          {selected && served
            ? `${seasonTitleCase(selected)} ${served.year}`
            : 'Season'}
        </Text>
        <Pressable
          onPress={() => router.push('/search')}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={styles.backTile}
        >
          <Search size={20} color={theme.text} strokeWidth={2} />
        </Pressable>
      </View>

      <View style={styles.chips}>
        {SEASON_ORDER.map((value) => {
          const active = selected === value;
          return (
            <Pressable
              key={value}
              onPress={() => setSelected(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Season: ${seasonTitleCase(value)}`}
              style={[styles.chip, active && { backgroundColor: theme.accent }]}
            >
              <Text style={[styles.chipText, active && { color: theme.onAccent }]}>
                {seasonTitleCase(value)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {data && (
        <Text style={styles.countLine}>
          {themes.length} themes this season
        </Text>
      )}

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this season.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>
            {themes.map((item) => (
              <ThemeRow
                key={item.slug}
                item={item}
                onPress={() => openTheme(item.slug)}
                onPlay={() => playTheme(item.slug, themes)}
                saved={favorites.isFavorite(item.slug)}
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => void favorites.toggle(item.slug)}
              />
            ))}
            {themes.length === 0 && (
              <Text style={styles.emptyText}>No themes this season yet.</Text>
            )}
            {data.hasMore && (
              <Pressable
                onPress={loadMore}
                disabled={loadingMore}
                accessibilityRole="button"
                accessibilityLabel="Load more themes"
                style={({ pressed }) => [
                  styles.loadMore,
                  pressed && styles.pressed,
                ]}
              >
                {loadingMore ? (
                  <ActivityIndicator size="small" color={theme.accent} />
                ) : (
                  <Text style={styles.loadMoreText}>Load more</Text>
                )}
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.display,
      color: theme.text,
      flex: 1,
    },
    chips: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.sm,
    },
    chip: {
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
    },
    chipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    countLine: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    loadMore: {
      alignSelf: 'center',
      minHeight: 40,
      paddingHorizontal: spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      marginTop: spacing.md,
    },
    loadMoreText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    pressed: {
      opacity: 0.85,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
    },
    errorText: {
      ...typeStyles.heading,
      color: theme.text,
    },
    errorDetail: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
    emptyText: {
      ...typeStyles.body,
      color: theme.muted,
      paddingTop: spacing.lg,
    },
  });
