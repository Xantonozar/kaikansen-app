import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, ExternalLink } from 'lucide-react-native';
import type { AnimeDetailResponse, ThemeSummary } from '@kaikansen/contracts';
import { fetchAnimeDetail } from '../../../src/api';
import { ThemeRow } from '../../../src/components/ThemeRow';
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
      // The queue is the page's rows in display order: Openings
      // (by sequence), then Endings (by sequence) — the same order
      // renderRows draws them.
      if (data) {
        const ordered = (['OP', 'ED'] as const).flatMap((type) =>
          data.themes
            .filter((t) => t.type === type)
            .sort((a, b) => a.sequence - b.sequence),
        );
        const index = ordered.findIndex((t) => t.slug === slug);
        if (index >= 0) {
          startQueue(queueItemsFromSummaries(ordered), index, 'watch');
        }
      }
      router.push({ pathname: '/player', params: { slug, mode: 'watch' } });
    },
    [router, data, startQueue],
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
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
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
        >
          {/* Full-bleed banner, 224dp (mock: h-56). */}
          {bannerUri ? (
            <Image source={{ uri: bannerUri }} style={styles.banner} />
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
  });
