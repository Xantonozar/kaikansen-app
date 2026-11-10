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
import { ArrowLeft, Search } from 'lucide-react-native';
import type { Season, SeasonResponse, ThemeSummary } from '@kaikansen/contracts';
import { fetchHome, fetchSeason } from '../../src/api';
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
 * Season browse (DESIGN.md §6.5) — Home's "View All". Rebuilt to
 * the Season design (season.html is the measurement truth): a
 * plain back arrow + the centred "<Season> <Year>" title + a
 * plain search icon (no tiles), the four season chips as
 * content-width pills in a hidden-scrollbar horizontal scroll
 * row (owner fix, 2026-11-10 — equal flex-1 shares wrapped the
 * "Summer" label), the "N themes this season" line, then ThemeRow's
 * `season` cut of the rows. The pre-fidelity build's All/OP/ED
 * type filter is not in the design; the endpoint's type
 * parameter stays available server-side.
 *
 * Data: GET /season (the web's /api/themes/seasonal read) with
 * real pagination (Load more while the server says hasMore —
 * seasons run past one 20-theme page, so the control stays even
 * though the mock's first screenful doesn't draw it). The count
 * line reads the response's `total` — the season's real size
 * across all pages, counted server-side under the same filter;
 * it never derives from the loaded rows' length.
 *
 * The screen learns which season+year is being served from
 * /home first — the API's fallback-aware current season — and
 * the chips switch season WITHIN that served year: the design
 * has no year switcher, and this screen has never browsed other
 * years, so none is removed. Title, selected chip and count all
 * describe the season actually loaded: a season with no data
 * (FALL 2026 serves none) gets its honest empty state under its
 * own name, never another season's rows.
 */
export default function SeasonScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
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
      // The shown list is the queue. Navigation goes to the theme
      // detail, not the player route — the player route is
      // playlist/offline-only (owner ruling 2026-11-10).
      const index = list.findIndex((t) => t.slug === slug);
      if (index >= 0) {
        startQueue(queueItemsFromSummaries(list), index, 'watch', 'other');
      }
      openTheme(slug);
    },
    [openTheme, startQueue],
  );

  const themes = data?.themes ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [
              styles.headerButton,
              styles.backButton,
              pressed && styles.pressed,
            ]}
          >
            <ArrowLeft size={24} color={theme.text} strokeWidth={2} />
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
            style={({ pressed }) => [
              styles.headerButton,
              styles.searchButton,
              pressed && styles.pressed,
            ]}
          >
            <Search size={22} color={theme.text} strokeWidth={2} />
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
        >
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
                  style={({ pressed }) => [
                    styles.chip,
                    active && styles.chipActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {seasonTitleCase(value)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {data && (
          <View style={styles.countWrap}>
            <Text style={styles.countLine}>
              {data.total} themes this season
            </Text>
          </View>
        )}
      </View>

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
                season
                onPress={() => openTheme(item.slug)}
                onPlay={() => playTheme(item.slug, themes)}
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
      // season.html: the sticky header block is px-4 pt-4 pb-2.
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerButton: {
      // season.html: bare 40x40 round hit areas, no tile behind
      // the glyphs; the -4 margins pull them to the screen edge.
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backButton: {
      marginLeft: -4,
    },
    searchButton: {
      marginRight: -4,
    },
    title: {
      // season.html: text-xl (20) bold, tracking-tight, centred;
      // the 8px right padding is the HTML's pr-2 optical offset.
      flex: 1,
      textAlign: 'center',
      paddingRight: spacing.sm,
      fontFamily: fontFamilies.display,
      fontSize: 20,
      letterSpacing: -0.5,
      color: theme.text,
    },
    chipsScroll: {
      // season.html: the chips row sits mt-3 under the title row.
      // The row scrolls horizontally when the pills don't fit;
      // the scrollbar is hidden (owner, 2026-11-10).
      marginTop: spacing.md,
    },
    chips: {
      // season.html: gap-2, a breath of vertical padding.
      flexDirection: 'row',
      gap: spacing.sm,
      paddingVertical: 2,
    },
    chip: {
      // Content-width pills (owner, 2026-11-10): the pre-fix
      // flex-1 equal shares squeezed the widest label ("Summer",
      // semibold when active) until it wrapped to two lines.
      // Pills now size to their label, never shrink, and the row
      // scrolls instead. py-1.5 px-3; the idle fill is the
      // HTML's #EDE5EC — theme.raised is the closest measured
      // token (the Leaderboard slice's precedent for this tone).
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radii.pill,
      backgroundColor: theme.raised,
    },
    chipActive: {
      backgroundColor: theme.accent,
    },
    chipText: {
      // season.html: text-xs (12); medium idle, semibold active.
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.accent,
    },
    chipTextActive: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    countWrap: {
      // season.html: the line sits pt-2 below the chips, inset a
      // further px-1 inside the header's padding.
      paddingTop: spacing.sm,
      paddingLeft: spacing.xs,
    },
    countLine: {
      // season.html: 12px medium in the mauve, tracking-wide.
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      letterSpacing: 0.3,
      color: theme.secondary,
    },
    content: {
      // season.html: the list is px-4 (the screen edge) pt-2.
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
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
