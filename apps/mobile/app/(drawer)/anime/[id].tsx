import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
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
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  LayoutGrid,
} from 'lucide-react-native';
import type {
  AnimeDetailResponse,
  AnimeFranchiseResponse,
  RelatedAnime,
  RelatedAnimeResponse,
  ThemeSummary,
} from '@kaikansen/contracts';
import {
  cacheKeyFor,
  fetchAnimeDetail,
  fetchAnimeFranchise,
  fetchRelatedAnime,
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
 * Anime detail (DESIGN.md §6.8) — rebuilt to the Anime Detail
 * design (measured in anime-detail.html): a full-bleed 224dp
 * banner (bannerImage, falling back to the large cover —
 * cover-fit in the banner area — the web page's own chain minus
 * its picsum placeholder), a floating translucent back disc, and
 * a white info card overlapping the banner by 16dp carrying the
 * title, the meta line and the genre chips; then the anime's
 * themes grouped Openings / Endings (ThemeRow's `anime` variant)
 * and a centred "View on AniList" link.
 *
 * Data: GET /anime/:id (the web's anime page read, ported to the
 * API for this screen). Every meta-line part renders ONLY from a
 * real payload field: "<n> episodes" from totalEpisodes, the
 * "SEASON YEAR" part from season/seasonYear. The mock's line
 * LEADS with a format ("TV ·") — format is ABSENT from the
 * payload and stored nowhere in the catalogue, and ozar declined
 * the anime-format backfill (2026-11-09), so the format part is
 * omitted rather than guessed (flagged in the design-fix report;
 * no backfill was built). Genre chips come from the payload's
 * genres (row omitted when empty); "View on AniList" renders
 * only when the payload carries an anilistId. The payload's
 * score/studio/romaji fields stay undrawn: not in the design.
 *
 * Below the themes (owner's order, 2026-11-15): "Related
 * Series" — poster cards for GET /anime/:id/related (the web
 * page's RelatedAnime rail: cover, title, season/year; a tap
 * opens that anime's page), hidden entirely when the list is
 * empty or the read fails, exactly as the web renders nothing
 * then — and "Franchise" (GET /anime/:id/franchise): ALL of
 * the franchise's themes grouped per season/anime in
 * chronological order, whose play discs claim the WHOLE flat
 * franchise list as the queue so playback (and the queue
 * preload) chains across seasons. The Franchise section hides
 * when the franchise is just this anime (its themes already
 * list above); search reaches this view in one tap — the
 * search anime row opens this page. The section's RENDERING
 * is progressive (owner's follow-up, 2026-11-15): a skeleton
 * shell while the fetch is in flight, then at most
 * FRANCHISE_PAGE_SIZE rows mounted, +1 batch per approach to
 * the page bottom (skeleton rows during each reveal) — the
 * DATA stays the one small fetch, so the whole-franchise play
 * claim above is unaffected.
 *
 * The section also has a dedicated screen now (owner order,
 * 2026-11-16): /franchise/:id holds the same franchise on its
 * own page with a Play All, and this page carries its entry
 * card under the themes whenever the section would show. The
 * inline section stays — the entry is a door, not a move.
 */
export default function AnimeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const animeId = Number.parseInt(id ?? '', 10);

  const [data, setData] = useState<AnimeDetailResponse | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [related, setRelated] = useState<RelatedAnime[]>([]);
  const [franchise, setFranchise] = useState<AnimeFranchiseResponse | null>(
    null,
  );
  /* Progressive reveal (owner's follow-up, 2026-11-15): how
     many franchise theme rows are MOUNTED — the data is all
     here from the one fetch; only the rendering is paged.
     franchisePending separates "fetch still in flight" from
     "no franchise" (both leave `franchise` null) so the
     section can hold a skeleton shell while it loads. */
  const [franchiseVisibleCount, setFranchiseVisibleCount] =
    useState(FRANCHISE_PAGE_SIZE);
  const [franchiseLoadingMore, setFranchiseLoadingMore] = useState(false);
  const [franchisePending, setFranchisePending] = useState(false);
  const franchiseRevealRef = useRef(false);
  const franchiseRevealTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  /* Silent swap (perf problem 5): a background revalidation of
     the CATALOGUE-cached detail replaces it in place. */
  useEffect(() => {
    if (fixtureMode || Number.isNaN(animeId)) return;
    return subscribeCache<AnimeDetailResponse | null>(
      cacheKeyFor(`/anime/${animeId}`),
      (fresh) => setData(fresh),
    );
  }, [animeId]);

  /* Silent swaps for the two sections below the themes, same
     pattern: background revalidations of their cached reads
     replace them in place. */
  useEffect(() => {
    if (fixtureMode || Number.isNaN(animeId)) return;
    const offRelated = subscribeCache<RelatedAnimeResponse>(
      cacheKeyFor(`/anime/${animeId}/related`),
      (fresh) => setRelated(fresh.related),
    );
    const offFranchise = subscribeCache<AnimeFranchiseResponse>(
      cacheKeyFor(`/anime/${animeId}/franchise`),
      (fresh) => setFranchise(fresh),
    );
    return () => {
      offRelated();
      offFranchise();
    };
  }, [animeId]);

  /* Related + franchise loads: independent of the detail read
     and of each other — both fetch helpers resolve their empty
     state ([] / null) on any failure, so a dead section read
     never takes the page down; the sections simply hide. */
  useEffect(() => {
    let live = true;
    setRelated([]);
    setFranchise(null);
    // A new anime starts the reveal over: first batch only, no
    // batch in flight, and no reveal timer from the old page.
    setFranchiseVisibleCount(FRANCHISE_PAGE_SIZE);
    setFranchiseLoadingMore(false);
    franchiseRevealRef.current = false;
    if (franchiseRevealTimer.current) {
      clearTimeout(franchiseRevealTimer.current);
      franchiseRevealTimer.current = null;
    }
    if (Number.isNaN(animeId)) {
      setFranchisePending(false);
      return;
    }
    setFranchisePending(true);
    void fetchRelatedAnime(animeId).then((res) => {
      if (live) setRelated(res);
    });
    void fetchAnimeFranchise(animeId).then((res) => {
      if (live) {
        setFranchise(res);
        setFranchisePending(false);
      }
    });
    return () => {
      live = false;
    };
  }, [animeId]);

  /* Never let a reveal timer outlive the screen. */
  useEffect(() => {
    return () => {
      if (franchiseRevealTimer.current) {
        clearTimeout(franchiseRevealTimer.current);
        franchiseRevealTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    if (Number.isNaN(animeId)) {
      setData(null);
      return;
    }
    fetchAnimeDetail(animeId)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load this anime.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [animeId]);

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );
  const { startQueue } = usePlaybackSession();
  const playTheme = useCallback(
    (slug: string) => {
      // The row's PLAY DISC (owner ruling 2026-11-12): claim
      // only, no navigation — the song plays in the mini player;
      // the card's own press opens the theme detail. The queue
      // is the page's rows in display order: Openings (by
      // sequence), then Endings (by sequence) — the same order
      // renderRows draws them. The claim mode is the user's
      // Open-themes-as mode, so the play records as what is
      // actually heard (counts fix RC1).
      if (data) {
        const ordered = (['OP', 'ED'] as const).flatMap((type) =>
          data.themes
            .filter((t) => t.type === type)
            .sort((a, b) => a.sequence - b.sequence),
        );
        const index = ordered.findIndex((t) => t.slug === slug);
        if (index >= 0) {
          startQueue(
            queueItemsFromSummaries(ordered),
            index,
            getOpenThemesAs(),
            'other',
          );
        }
      }
    },
    [data, startQueue],
  );

  const renderRows = (rows: ThemeSummary[]) =>
    rows.map((item) => (
      <ThemeRow
        key={item.slug}
        item={item}
        anime
        onPress={() => openTheme(item.slug)}
        onPlay={() => playTheme(item.slug)}
      />
    ));

  /* Franchise play (owner's order, 2026-11-15): a franchise
     row's PLAY DISC claims the WHOLE franchise — every group
     flattened in display order — at the tapped row, in the
     user's Open-themes-as mode (the same claim shape as the
     page's own rows), so the queue walks season after season
     and the queue preload chains across them. Claim only, no
     navigation; the card's press opens the theme detail. */
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

  const showFranchise = franchiseSectionVisible(franchise, animeId);
  const franchiseServedThemes = franchise
    ? franchise.groups.reduce((n, g) => n + g.themes.length, 0)
    : 0;

  /* Reveal the next franchise batch: skeleton rows show for a
     short beat (~300ms) so the user SEES the loading state
     while the next batch mounts, then the budget grows by one
     page. The ref guard makes the trigger non-reentrant — a
     scroll storm near the bottom cannot queue two batches. */
  const revealMoreFranchise = useCallback(() => {
    if (franchiseRevealRef.current || franchiseLoadingMore) return;
    if (!franchise || !showFranchise) return;
    if (!franchiseHasMore(franchise.groups, franchiseVisibleCount)) return;
    franchiseRevealRef.current = true;
    setFranchiseLoadingMore(true);
    franchiseRevealTimer.current = setTimeout(() => {
      franchiseRevealTimer.current = null;
      setFranchiseVisibleCount((n) => n + FRANCHISE_PAGE_SIZE);
      setFranchiseLoadingMore(false);
      franchiseRevealRef.current = false;
    }, 300);
  }, [franchise, showFranchise, franchiseVisibleCount, franchiseLoadingMore]);

  const onPageScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      if (distanceFromBottom < 500) revealMoreFranchise();
    },
    [revealMoreFranchise],
  );

  const metaLine = data
    ? [
        data.anime.totalEpisodes != null
          ? `${data.anime.totalEpisodes} episodes`
          : null,
        data.anime.season && data.anime.seasonYear
          ? `${data.anime.season} ${data.anime.seasonYear}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const bannerUri = data?.anime.bannerImage ?? data?.anime.coverImageLarge;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Floating back disc over the banner (the design's only
          chrome on this screen — there is no title bar). */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backFloat}
      >
        <ArrowLeft size={20} color={theme.text} strokeWidth={2} />
      </Pressable>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this anime.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : data === undefined ? (
        /* Initial load (skeleton sweep): the page's own shape —
           the 224dp banner block, the info card's title/meta
           bars, then theme-row shapes. No page spinner. */
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <SkeletonBlock width="100%" height={224} radius={0} />
          <View style={styles.column}>
            <View style={styles.infoCard}>
              <SkeletonBlock width="72%" height={18} radius={6} />
              <SkeletonBlock width="46%" height={12} radius={5} style={{ marginTop: 8 }} />
            </View>
            <View style={styles.section}>
              <SkeletonThemeRow />
              <SkeletonThemeRow />
              <SkeletonThemeRow />
            </View>
          </View>
        </ScrollView>
      ) : data === null ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Anime not found</Text>
          <Text style={styles.errorDetail}>
            This anime isn’t in the catalogue yet.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          onScroll={onPageScroll}
          scrollEventThrottle={200}
        >
          {/* Full-bleed banner, 224dp (mock: h-56). */}
          {bannerUri ? (
            <AppImage source={bannerUri} style={styles.banner} />
          ) : (
            <View style={[styles.banner, styles.placeholder]} />
          )}
          <View style={styles.column}>
            {/* Info card overlapping the banner by 16dp (mock: -mt-4). */}
            <View style={styles.infoCard}>
              <Text style={styles.title}>
                {data.anime.titleEnglish ?? data.anime.titleRomaji}
              </Text>
              {metaLine.length > 0 && (
                <Text style={styles.metaLine}>{metaLine}</Text>
              )}
              {data.anime.genres.length > 0 && (
                <View style={styles.genreRow}>
                  {data.anime.genres.map((genre) => (
                    <View key={genre} style={styles.genreChip}>
                      <Text style={styles.genreText}>{genre}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {(['OP', 'ED'] as const).map((type) => {
              const rows = data.themes
                .filter((t) => t.type === type)
                .sort((a, b) => a.sequence - b.sequence);
              if (rows.length === 0) return null;
              return (
                <View key={type} style={styles.section}>
                  <Text style={styles.sectionHeading}>
                    {type === 'OP' ? 'Openings' : 'Endings'}
                  </Text>
                  {renderRows(rows)}
                </View>
              );
            })}
            {data.themes.length === 0 && (
              <Text style={styles.emptyText}>
                No themes for this anime yet.
              </Text>
            )}

            {/* Franchise entry (owner order, 2026-11-16): the
                dedicated franchise screen's door on this page —
                shown under the same rule as the section below
                (a franchise of just this anime gets no entry),
                opening /franchise/:id with every season's themes
                and a Play All. The inline section below stays as
                the in-page browse. */}
            {showFranchise && franchise && (
              <Pressable
                onPress={() => router.push(`/franchise/${animeId}`)}
                accessibilityRole="button"
                accessibilityLabel={`Open the franchise — ${franchise.totalThemes} themes across ${franchise.totalGroups} anime`}
                style={({ pressed }) => [
                  styles.franchiseEntry,
                  pressed && styles.pressed,
                ]}
              >
                <LayoutGrid size={19} color={theme.accent} strokeWidth={2} />
                <View style={styles.franchiseEntryMain}>
                  <Text style={styles.franchiseEntryTitle}>Franchise</Text>
                  <Text style={styles.franchiseEntryMeta} numberOfLines={1}>
                    {franchise.totalThemes}{' '}
                    {franchise.totalThemes === 1 ? 'theme' : 'themes'} across{' '}
                    {franchise.totalGroups} anime — every season together
                  </Text>
                </View>
                <ChevronRight
                  size={18}
                  color={theme.secondary}
                  strokeWidth={2}
                />
              </Pressable>
            )}

            {/* Related Series (web parity): poster cards in a
                two-up grid — cover, title, season/year. Hidden
                entirely when the read answered empty or failed
                (the web renders nothing then). */}
            {related.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionHeading}>Related Series</Text>
                <View style={styles.relatedGrid}>
                  {related.map((item) => (
                    <Pressable
                      key={item.anilistId ?? item.titleRomaji}
                      onPress={() =>
                        item.anilistId != null &&
                        router.push(`/anime/${item.anilistId}`)
                      }
                      disabled={item.anilistId == null}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${item.titleEnglish ?? item.titleRomaji}`}
                      style={({ pressed }) => [
                        styles.relatedCard,
                        pressed && styles.pressed,
                      ]}
                    >
                      {item.coverImageLarge ?? item.coverImageMedium ? (
                        <AppImage
                          source={
                            item.coverImageLarge ?? item.coverImageMedium ?? ''
                          }
                          style={styles.relatedCover}
                        />
                      ) : (
                        <View style={[styles.relatedCover, styles.placeholder]} />
                      )}
                      <Text style={styles.relatedTitle} numberOfLines={2}>
                        {item.titleEnglish ?? item.titleRomaji}
                      </Text>
                      {(item.season || item.seasonYear) && (
                        <Text style={styles.relatedMeta} numberOfLines={1}>
                          {[item.season, item.seasonYear]
                            .filter(Boolean)
                            .join(' ')}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {/* Franchise skeleton shell: while the franchise
                fetch is still in flight the section holds its
                place under Related Series with the heading and
                theme-row shapes. When the fetch resolves it is
                replaced by the real section — or disappears
                entirely when the franchise turns out to be just
                this anime (the hide rule below). A cached
                response may already have swapped the real
                section in; the shell then never shows. */}
            {franchisePending && !showFranchise && (
              <View style={styles.section}>
                <Text style={styles.sectionHeading}>Franchise</Text>
                <SkeletonThemeRow />
                <SkeletonThemeRow />
                <SkeletonThemeRow />
              </View>
            )}

            {/* Franchise: every season's themes together,
                grouped per anime in chronological order; a
                group's header opens that anime's page (the
                current anime's own header is inert — the user
                is already here). Only the visible budget of
                rows is MOUNTED (progressive reveal — see
                franchiseVisibleGroups); the header still reads
                the full group's count, and plays still claim
                the whole franchise. */}
            {showFranchise && franchise && (
              <View style={styles.section}>
                <Text style={styles.sectionHeading}>Franchise</Text>
                {franchise.totalGroups > 1 && (
                  <Text style={styles.franchiseMeta}>
                    {franchise.totalThemes}{' '}
                    {franchise.totalThemes === 1 ? 'theme' : 'themes'} across{' '}
                    {franchise.totalGroups} anime
                  </Text>
                )}
                {franchise.truncated && (
                  <Text style={styles.franchiseMeta}>
                    Showing {franchiseServedThemes} of{' '}
                    {franchise.totalThemes} themes — the largest
                    franchises are capped.
                  </Text>
                )}
                {franchiseVisibleGroups(
                  franchise.groups,
                  franchiseVisibleCount,
                ).map(({ group: g, themes: visibleThemes }) => {
                  const seasonLine = franchiseGroupSeasonLine(g.anime);
                  const isCurrent = g.anime.anilistId === animeId;
                  return (
                    <View
                      key={g.anime.anilistId ?? g.anime.titleRomaji}
                      style={styles.franchiseGroup}
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
                          onPress={() => openTheme(item.slug)}
                          onPlay={() => playFranchiseTheme(item.slug)}
                        />
                      ))}
                    </View>
                  );
                })}
                {/* Next-batch reveal in flight: skeleton rows
                    hold the space at the end of the groups
                    until the budget grows and the real rows
                    mount (~300ms — see revealMoreFranchise). */}
                {franchiseLoadingMore && (
                  <>
                    <SkeletonThemeRow />
                    <SkeletonThemeRow />
                    <SkeletonThemeRow />
                  </>
                )}
              </View>
            )}

            {data.anime.anilistId != null && (
              <Pressable
                onPress={() =>
                  void Linking.openURL(
                    `https://anilist.co/anime/${data.anime.anilistId}`,
                  )
                }
                accessibilityRole="link"
                accessibilityLabel="View on AniList"
                style={({ pressed }) => [
                  styles.anilistRow,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.anilistText}>View on AniList</Text>
                <ExternalLink size={14} color={theme.accent} strokeWidth={2} />
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
    backFloat: {
      // The mock's floating back disc (anime-detail.html: top-4
      // left-4, w-9 h-9, white/80): translucent white over the
      // banner (the same fixed-colour precedent as the scrims;
      // token `surface` at 80% renders identically in the light
      // theme and follows the dark theme's surface).
      position: 'absolute',
      top: spacing.lg,
      left: spacing.screenEdge,
      zIndex: 2,
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      opacity: 0.8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      paddingBottom: spacing.xxxl,
    },
    banner: {
      width: '100%',
      height: 224,
      backgroundColor: theme.surface,
    },
    placeholder: {
      backgroundColor: theme.raised,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
    },
    infoCard: {
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.cardLg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      marginTop: -spacing.lg,
    },
    title: {
      // anime-detail.html: text-xl bold, leading-snug (1.375).
      ...typeStyles.display,
      fontSize: 20,
      lineHeight: 28,
      color: theme.text,
    },
    metaLine: {
      // anime-detail.html: 12px medium mauve, tracking-wide
      // (0.025em ≈ 0.3), NO case transform — the stored season
      // is already uppercase ("FALL 1995") and "episodes" stays
      // lowercase, exactly as the HTML's text reads.
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      letterSpacing: 0.3,
      color: theme.secondary,
      marginTop: spacing.sm,
    },
    genreRow: {
      // anime-detail.html: gap-1.5 (6), mt-0.5 (2) on top of the
      // card's gap-2 (8) — 10 below the meta line.
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 10,
    },
    genreChip: {
      // anime-detail.html: px-2.5 (10) py-0.5 (2), chip bg
      // #F1E9F1 — the accentContainer token is the theme's
      // measured lavenderChip (Season slice precedent).
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 2,
    },
    genreText: {
      // anime-detail.html: 11px semibold in the deep mauve.
      fontSize: 11,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    anilistRow: {
      // anime-detail.html: a centred text link, no card —
      // py-2 (8), gap-1 (4), in the content column's gap-4 (16)
      // flow below the last section.
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      marginTop: spacing.lg,
    },
    anilistText: {
      // anime-detail.html: 12px bold in the deep mauve.
      fontSize: 12,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    pressed: {
      opacity: 0.85,
    },
    section: {
      // anime-detail.html: sections sit in the column's gap-4
      // (16) flow with pt-1 (4) of their own.
      marginTop: spacing.lg,
      paddingTop: spacing.xs,
    },
    sectionHeading: {
      // anime-detail.html: 14px bold, px-1 (4) inset, gap-2 (8)
      // above the section's first row card.
      fontSize: 14,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      paddingHorizontal: spacing.xs,
      marginBottom: spacing.sm,
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
    relatedGrid: {
      // The web's Related Series grid at phone width: two
      // poster cards per row, the column gap as the gutter.
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
    },
    relatedCard: {
      width: '47%',
      flexGrow: 1,
    },
    relatedCover: {
      // AniList covers are 2:3 portraits (the web card's
      // aspect-[2/3]); radius follows the poster treatment
      // (DESIGN.md §7: images inherit their container's radius,
      // 24 for poster cards).
      width: '100%',
      aspectRatio: 2 / 3,
      borderRadius: radii.card,
      backgroundColor: theme.surface,
    },
    relatedTitle: {
      // The web card's title under the poster: 12px bold,
      // two lines before it truncates.
      fontSize: 12,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      marginTop: spacing.sm,
    },
    relatedMeta: {
      // The web overlay's "YEAR SEASON" line, set as meta text
      // under the title (the meta-line typography of this page).
      fontSize: 11,
      fontFamily: 'Inter_500Medium',
      letterSpacing: 0.3,
      color: theme.secondary,
      marginTop: 2,
    },
    franchiseEntry: {
      // The dedicated screen's door: a surface card in the
      // column flow, icon + two lines + chevron.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginTop: spacing.lg,
    },
    franchiseEntryMain: {
      flex: 1,
    },
    franchiseEntryTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    franchiseEntryMeta: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: 1,
    },
    franchiseMeta: {
      // The section's honest totals line (and its truncation
      // note): meta typography, inset like the headings.
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      color: theme.muted,
      paddingHorizontal: spacing.xs,
      marginBottom: spacing.sm,
    },
    franchiseGroup: {
      marginTop: spacing.md,
    },
    groupHeader: {
      // The Library AniList segment's group header pattern: a
      // small portrait cover, the anime's title + season/meta
      // line, and a chevron when the header navigates.
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
