import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image as ExpoImage } from '../../../src/expoImage';
import type { ImageSource as ExpoImageSource } from 'expo-image';
import { cloudinarySized } from '../../../src/imageVariants';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import type { ArtistDetailResponse } from '@kaikansen/contracts';
import {
  cacheKeyFor,
  fetchArtistDetail,
  fixtureMode,
  subscribeCache,
} from '../../../src/api';
import { useFavorites } from '../../../src/favoritesStore';
import { pickDefaultArtist } from '../../../src/defaultArtists';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  SkeletonBlock,
  SkeletonThemeRow,
} from '../../../src/components/Skeleton';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../../src/playback-context';
import { getOpenThemesAs } from '../../../src/playbackSettings';
import type { ThemeSummary } from '@kaikansen/contracts';
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
 * Artist detail (DESIGN.md §6.9) — rebuilt to the Artist Detail
 * mock (artist-detail.html): a lone white back disc, a white
 * header card (centred 80pt artist image, name, theme-count
 * subline), then "Themes by <name>" / POPULAR and the artist's
 * themes as mock-cut rows. Data: GET /artists/:slug (the web's
 * artist page read, ported).
 *
 * Image fallback (owner order 2026-11-10): a real catalogue image
 * wins; when imageUrl is null, an .svg (undrawable in RN), or the
 * remote load fails, the hero shows the artist's deterministic
 * Cloudinary-hosted chibi musician (src/defaultArtists.ts,
 * FNV-1a of the slug % 20) instead of the initial-letter disc
 * the mock draws.
 */
export default function ArtistDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const { slug } = useLocalSearchParams<{ slug: string }>();

  const [data, setData] = useState<ArtistDetailResponse | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  /* Silent swap (perf problem 5): a background revalidation of
     the CATALOGUE-cached detail replaces it in place. */
  useEffect(() => {
    if (fixtureMode || !slug) return;
    return subscribeCache<ArtistDetailResponse | null>(
      cacheKeyFor(`/artists/${encodeURIComponent(slug)}`),
      (fresh) => setData(fresh),
    );
  }, [slug]);

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    setImageError(false);
    if (!slug) {
      setData(null);
      return;
    }
    fetchArtistDetail(slug)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load this artist.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [slug]);

  const openTheme = useCallback(
    (themeSlug: string) => router.push(`/theme/${themeSlug}`),
    [router],
  );
  const { startQueue } = usePlaybackSession();
  const playTheme = useCallback(
    (themeSlug: string, list: ThemeSummary[]) => {
      // The row's PLAY DISC (owner ruling 2026-11-12): claim
      // only, no navigation — the song plays in the mini player;
      // the card's own press opens the theme detail. The
      // artist's shown list (most-watched first) is the queue.
      // The claim mode is the user's Open-themes-as mode, so the
      // play records as what is actually heard (counts fix RC1).
      const index = list.findIndex((t) => t.slug === themeSlug);
      if (index >= 0) {
        startQueue(
          queueItemsFromSummaries(list),
          index,
          getOpenThemesAs(),
          'other',
        );
      }
    },
    [startQueue],
  );

  const themes = useMemo(
    () =>
      data
        ? [...data.themes].sort((a, b) => b.totalWatches - a.totalWatches)
        : [],
    [data],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backDisc}
        >
          <ArrowLeft size={20} color={theme.accent} strokeWidth={2} />
        </Pressable>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this artist.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : data === undefined ? (
        /* Initial load (skeleton sweep): the hero card's shape —
           the 80pt portrait circle, name + subline bars — then
           theme-row shapes. No page spinner. */
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>
            <View style={styles.hero}>
              <SkeletonBlock width={80} height={80} radius={999} />
              <SkeletonBlock width="52%" height={17} radius={6} style={{ marginTop: 12 }} />
              <SkeletonBlock width="30%" height={12} radius={5} style={{ marginTop: 8 }} />
            </View>
            <SkeletonThemeRow />
            <SkeletonThemeRow />
            <SkeletonThemeRow />
          </View>
        </ScrollView>
      ) : data === null ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Artist not found</Text>
          <Text style={styles.errorDetail}>
            This artist isn’t in the catalogue yet.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>
            <View style={styles.hero}>
              {data.artist.imageUrl &&
              !data.artist.imageUrl.toLowerCase().includes('.svg') &&
              !imageError ? (
                <ExpoImage
                  source={{ uri: cloudinarySized(data.artist.imageUrl, 360) }}
                  style={styles.artistImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  onError={() => setImageError(true)}
                  accessibilityLabel={`${data.artist.name}'s image`}
                />
              ) : (
                <ExpoImage
                  source={pickDefaultArtist(data.artist.slug) as ExpoImageSource}
                  style={styles.artistImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  accessibilityLabel={`${data.artist.name}'s image`}
                />
              )}
              <Text style={styles.name}>{data.artist.name}</Text>
              {/* The design's subline is plain text ("24 themes ·
                  J-Pop / Anison"), not a chip. Artist genres are
                  NOT in the payload (ArtistCache has none), so
                  only the theme count renders — flagged in the
                  Slice 6 report; the aliases line the pre-fidelity
                  build drew is not in the design either. */}
              <Text style={styles.subline}>
                {data.artist.totalThemes}{' '}
                {data.artist.totalThemes === 1 ? 'theme' : 'themes'}
              </Text>
            </View>

            <View style={styles.headingRow}>
              <Text style={styles.sectionHeading}>
                Themes by {data.artist.name}
              </Text>
              <Text style={styles.popularCaption}>POPULAR</Text>
            </View>
            {themes.map((item) => (
              <ThemeRow
                key={item.slug}
                item={item}
                artist
                metaText={item.animeTitle}
                onPress={() => openTheme(item.slug)}
                onPlay={() => playTheme(item.slug, themes)}
                saved={favorites.isFavorite(item.slug)}
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => void favorites.toggle(item.slug)}
              />
            ))}
            {themes.length === 0 && (
              <Text style={styles.emptyText}>
                No themes by this artist yet.
              </Text>
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
      // artist-detail.html: a lone back disc, py-1 with mb-2.
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.xs,
      marginBottom: spacing.sm,
    },
    backDisc: {
      // artist-detail.html: w-9 h-9 (36) white disc, hairline
      // border, arrow in the deep mauve.
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
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
    hero: {
      // artist-detail.html: the header is a white card —
      // rounded-3xl (24), p-6 (24), hairline border, centred.
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      padding: 24,
    },
    artistImage: {
      // artist-detail.html: w-20 h-20 (80) circle.
      width: 80,
      height: 80,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
    },
    name: {
      // artist-detail.html: headline-md (22/30), bold, mt-3 (12).
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 22,
      lineHeight: 30,
      letterSpacing: -0.3,
      color: theme.text,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    subline: {
      // artist-detail.html: label-md (13/18) medium in the mauve
      // (#8E5B7B = theme.secondary), mt-1 (4).
      fontFamily: fontFamilies.caption,
      fontSize: 13,
      lineHeight: 18,
      color: theme.secondary,
      textAlign: 'center',
      marginTop: spacing.xs,
    },
    headingRow: {
      // artist-detail.html: px-1 (4), mt-6 (24), mb-3 (12).
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xs,
      marginTop: 24,
      marginBottom: spacing.md,
    },
    sectionHeading: {
      // artist-detail.html: title-sm (17/24) bold, tracking-tight.
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 17,
      lineHeight: 24,
      letterSpacing: -0.2,
      color: theme.text,
      flexShrink: 1,
    },
    popularCaption: {
      // artist-detail.html: label-sm (11) semibold, letterspaced,
      // in the mauve (#8E5B7B = theme.secondary).
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      letterSpacing: 0.5,
      color: theme.secondary,
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
    },
  });
