import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { AppImage } from '../../../src/components/AppImage';
import {
  SkeletonBlock,
  SkeletonThemeRow,
} from '../../../src/components/Skeleton';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, ChevronRight, Play } from 'lucide-react-native';
import type { AnimeFranchiseResponse } from '@kaikansen/contracts';
import {
  cacheKeyFor,
  fetchAnimeFranchise,
  fixtureMode,
  subscribeCache,
} from '../../../src/api';
import {
  FRANCHISE_PAGE_SIZE,
  franchiseFlatThemes,
  franchiseGroupSeasonLine,
  franchiseHasMore,
  franchiseSectionVisible,
  franchiseVisibleGroups,
} from '../../../src/franchise';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { getOpenThemesAs } from '../../../src/playbackSettings';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Franchise (owner order, 2026-11-16) — the dedicated screen
 * for GET /anime/:id/franchise: EVERY theme of the franchise
 * the anime at :id belongs to, grouped per season/anime in
 * chronological order, with a Play All that claims the whole
 * flat franchise as the queue. Until this screen existed the
 * franchise lived only as an inline section on the anime page;
 * the owner's order gives it its own home, reached from the
 * anime page's Franchise entry card, the theme page's
 * Franchise chip and its "Franchise & Seasons" See-all.
 *
 * The behaviours are the anime page section's, unchanged: a
 * row's play disc claims the WHOLE franchise at that row (the
 * queue chains across seasons), a group's header opens that
 * anime's page (the requested anime's own header is inert),
 * rendering is progressive (FRANCHISE_PAGE_SIZE rows mounted,
 * +1 batch per approach to the bottom — the DATA is the one
 * fetch, so play claims are unaffected), and the same totals /
 * truncation honesty lines print. A franchise that is just the
 * requested anime (or an empty read) is NOT a franchise: the
 * screen says so plainly instead of duplicating the anime
 * page's own theme list.
 */
export default function FranchiseScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const animeId = Number.parseInt(id ?? '', 10);

  const [franchise, setFranchise] =
    useState<AnimeFranchiseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [visibleCount, setVisibleCount] = useState(FRANCHISE_PAGE_SIZE);

  /* Silent swap (perf problem 5): a background revalidation of
     the cached read replaces the page in place — the same
     subscription the anime page holds for this endpoint. */
  useEffect(() => {
    if (fixtureMode || Number.isNaN(animeId)) return;
    return subscribeCache<AnimeFranchiseResponse>(
      cacheKeyFor(`/anime/${animeId}/franchise`),
      (fresh) => setFranchise(fresh),
    );
  }, [animeId]);

  useEffect(() => {
    let live = true;
    setFranchise(null);
    setError(null);
    setVisibleCount(FRANCHISE_PAGE_SIZE);
    if (Number.isNaN(animeId)) {
      setError('This franchise link is not valid.');
      return;
    }
    setPending(true);
    fetchAnimeFranchise(animeId)
      .then((res) => {
        if (live) setFranchise(res);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load this franchise.',
          );
        }
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [animeId]);

  const { startQueue } = usePlaybackSession();

  /* A row's play disc claims the whole flat franchise at that
     row (the anime page's franchise-play shape, 2026-11-15);
     the card's own press opens the theme detail. */
  const playFranchiseTheme = useCallback(
    (slug: string) => {
      if (!franchise) return;
      const flat = franchiseFlatThemes(franchise.groups);
      const index = flat.findIndex((t) => t.slug === slug);
      if (index >= 0) {
        startQueue(
          queueItemsFromSummaries(flat),
          index,
          getOpenThemesAs(),
          'other',
        );
      }
    },
    [franchise, startQueue],
  );

  /** Play All: the whole franchise from the top, one queue. */
  const playAll = useCallback(() => {
    if (!franchise) return;
    const flat = franchiseFlatThemes(franchise.groups);
    if (flat.length === 0) return;
    startQueue(queueItemsFromSummaries(flat), 0, getOpenThemesAs(), 'other');
  }, [franchise, startQueue]);

  /* One growth per scroll approach (audit, 2026-11-16): scroll
     events keep firing against the same render's closure, and
     functional +PAGE updates would stack (+20 per event) until
     the re-render lands. The ref locks until the grown budget
     actually renders, then the effect below re-arms it. */
  const revealLockRef = useRef(false);
  useEffect(() => {
    revealLockRef.current = false;
  }, [visibleCount]);

  const onPageScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      if (distanceFromBottom < 500 && franchise && !revealLockRef.current) {
        if (franchiseHasMore(franchise.groups, visibleCount)) {
          revealLockRef.current = true;
          setVisibleCount((n) => n + FRANCHISE_PAGE_SIZE);
        }
      }
    },
    [franchise, visibleCount],
  );

  const showFranchise = franchiseSectionVisible(franchise, animeId);
  const ownGroup = franchise?.groups.find(
    (g) => g.anime.anilistId === animeId,
  );
  const ownTitle = ownGroup
    ? (ownGroup.anime.titleEnglish ?? ownGroup.anime.titleRomaji)
    : null;
  const servedThemes = franchise
    ? franchise.groups.reduce((n, g) => n + g.themes.length, 0)
    : 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.column}>
        <View style={styles.topRow}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [
              styles.backDisc,
              pressed && styles.pressed,
            ]}
          >
            <ArrowLeft size={20} color={theme.text} strokeWidth={2} />
          </Pressable>
          <View style={styles.headMain}>
            <Text style={styles.eyebrow}>FRANCHISE</Text>
            <Text style={styles.title} numberOfLines={2}>
              {ownTitle ?? 'Franchise'}
            </Text>
            {showFranchise && franchise && (
              <Text style={styles.metaLine}>
                {franchise.totalThemes}{' '}
                {franchise.totalThemes === 1 ? 'theme' : 'themes'} across{' '}
                {franchise.totalGroups} anime
              </Text>
            )}
          </View>
          {showFranchise && franchise && (
            <Pressable
              onPress={playAll}
              accessibilityRole="button"
              accessibilityLabel="Play the whole franchise"
              style={({ pressed }) => [
                styles.playAllDisc,
                pressed && styles.pressed,
              ]}
            >
              <Play size={20} color={theme.onAccent} strokeWidth={2} />
            </Pressable>
          )}
        </View>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this franchise.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : pending && !franchise ? (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>
            <SkeletonBlock width="60%" height={14} radius={6} />
            <View style={styles.section}>
              <SkeletonThemeRow />
              <SkeletonThemeRow />
              <SkeletonThemeRow />
            </View>
          </View>
        </ScrollView>
      ) : !showFranchise || !franchise ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>No franchise here</Text>
          <Text style={styles.errorDetail}>
            This anime doesn’t belong to a multi-anime franchise — its
            themes all live on its own page.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          onScroll={onPageScroll}
          scrollEventThrottle={200}
        >
          <View style={styles.column}>
            {franchise.truncated && (
              <Text style={styles.truncationNote}>
                Showing {servedThemes} of {franchise.totalThemes} themes —
                the largest franchises are capped.
              </Text>
            )}
            {franchiseVisibleGroups(franchise.groups, visibleCount).map(
              ({ group: g, themes: visibleThemes }) => {
                const seasonLine = franchiseGroupSeasonLine(g.anime);
                const isCurrent = g.anime.anilistId === animeId;
                return (
                  <View
                    key={g.anime.anilistId ?? g.anime.titleRomaji}
                    style={styles.group}
                  >
                    <Pressable
                      onPress={() =>
                        g.anime.anilistId != null &&
                        router.push(`/anime/${g.anime.anilistId}`)
                      }
                      disabled={isCurrent || g.anime.anilistId == null}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${g.anime.titleEnglish ?? g.anime.titleRomaji}`}
                      style={({ pressed }) => [
                        styles.groupHeader,
                        pressed && styles.pressed,
                      ]}
                    >
                      {g.anime.coverImageLarge ?? g.anime.coverImageMedium ? (
                        <AppImage
                          source={
                            g.anime.coverImageLarge ??
                            g.anime.coverImageMedium ??
                            ''
                          }
                          style={styles.groupCover}
                        />
                      ) : (
                        <View style={[styles.groupCover, styles.placeholder]} />
                      )}
                      <View style={styles.groupMain}>
                        <Text style={styles.groupTitle} numberOfLines={1}>
                          {g.anime.titleEnglish ?? g.anime.titleRomaji}
                        </Text>
                        <Text style={styles.groupMeta} numberOfLines={1}>
                          {seasonLine ? `${seasonLine} · ` : ''}
                          {g.themes.length}{' '}
                          {g.themes.length === 1 ? 'theme' : 'themes'}
                        </Text>
                      </View>
                      {!isCurrent && g.anime.anilistId != null && (
                        <ChevronRight
                          size={18}
                          color={theme.secondary}
                          strokeWidth={2}
                        />
                      )}
                    </Pressable>
                    {visibleThemes.map((item) => (
                      <ThemeRow
                        key={item.slug}
                        item={item}
                        anime
                        onPress={() => router.push(`/theme/${item.slug}`)}
                        onPlay={() => playFranchiseTheme(item.slug)}
                      />
                    ))}
                  </View>
                );
              },
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
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
    },
    content: {
      paddingBottom: spacing.xxxl,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    backDisc: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headMain: {
      flex: 1,
    },
    eyebrow: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
      letterSpacing: 1.4,
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      marginTop: 2,
    },
    metaLine: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      letterSpacing: 0.3,
      color: theme.secondary,
      marginTop: 2,
    },
    playAllDisc: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
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
    section: {
      marginTop: spacing.lg,
    },
    truncationNote: {
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      color: theme.muted,
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
    },
    group: {
      marginTop: spacing.md,
    },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
      marginBottom: spacing.sm,
    },
    groupCover: {
      width: 44,
      height: 59,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    placeholder: {
      backgroundColor: theme.raised,
    },
    groupMain: {
      flex: 1,
    },
    groupTitle: {
      fontSize: 13,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    groupMeta: {
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
      letterSpacing: 0.3,
      color: theme.secondary,
      marginTop: 2,
    },
  });
