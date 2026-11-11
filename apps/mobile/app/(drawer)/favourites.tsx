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
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, Heart } from 'lucide-react-native';
import type { FavoritesResponse } from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../src/api';
import { useAuth } from '../../src/auth';
import { ThemeRow } from '../../src/components/ThemeRow';
import { SkeletonThemeRow } from '../../src/components/Skeleton';
import { syncFavoriteSlugs, useFavorites } from '../../src/favoritesStore';
import { fetchFavorites } from '../../src/libraryApi';
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

/**
 * Favourites (DESIGN.md §6.12, layout-fidelity Slice 4) — the
 * standalone screen over the SAME data as Library → Saved: GET
 * /library/favorites, paged, with the favourites store keeping
 * every surface in step. Rows are the shared ThemeRow; the row's
 * toggle un-favourites in place (the row drops out and the count
 * follows), play claims the loaded list as the queue — both
 * exactly the Library segment's behaviour, presented as the
 * designed full screen ("N favourite themes" + rows). The row
 * ⋮ menu belongs to Slice 5, like everywhere else. Entered from
 * Library → Saved's "View all" (the §6.10/§6.11 entry model).
 */
export default function FavouritesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';
  const favorites = useFavorites();
  const { startQueue } = usePlaybackSession();

  const [fav, setFav] = useState<FavoritesResponse | null>(null);
  const [favPage, setFavPage] = useState(1);
  const [favError, setFavError] = useState<string | null>(null);
  const [favBusy, setFavBusy] = useState(false);

  const loadFirst = useCallback(() => {
    if (!signedIn || fixtureMode) return;
    fetchFavorites(1)
      .then((res) => {
        setFav(res);
        setFavPage(1);
        setFavError(null);
        syncFavoriteSlugs(res.themes);
      })
      .catch((e: unknown) =>
        setFavError(e instanceof Error ? e.message : 'Could not load saves.'),
      );
  }, [signedIn]);

  /* Silent swap (perf problem 5): a background revalidation of
     page 1 replaces it in place — only while page 1 alone shows. */
  useEffect(() => {
    if (!signedIn || fixtureMode) return;
    return subscribeCache<FavoritesResponse>(
      cacheKeyFor('/library/favorites?page=1&limit=50'),
      (fresh) => {
        setFav((prev) => (prev && favPage > 1 ? prev : fresh));
        if (favPage <= 1) {
          setFavError(null);
          syncFavoriteSlugs(fresh.themes);
        }
      },
    );
    // favPage is read live at notify time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  /* The screen is pushed, not a tab — freshness is focus-driven,
     like the Library's (an unsave elsewhere drops out here). */
  useFocusEffect(
    useCallback(() => {
      loadFirst();
    }, [loadFirst]),
  );

  const unsave = useCallback(
    (slug: string) => {
      void favorites.toggle(slug).then((err) => {
        if (err) return;
        setFav((prev) =>
          prev
            ? {
                ...prev,
                themes: prev.themes.filter((t) => t.slug !== slug),
                total: Math.max(0, prev.total - 1),
              }
            : prev,
        );
      });
    },
    [favorites],
  );

  const loadMore = useCallback(() => {
    if (!fav || !fav.hasMore || favBusy) return;
    setFavBusy(true);
    fetchFavorites(favPage + 1)
      .then((res) => {
        setFav((prev) =>
          prev ? { ...res, themes: [...prev.themes, ...res.themes] } : res,
        );
        setFavPage(favPage + 1);
        syncFavoriteSlugs(res.themes);
      })
      .catch((e: unknown) =>
        setFavError(
          e instanceof Error ? e.message : 'Could not load more saves.',
        ),
      )
      .finally(() => setFavBusy(false));
  }, [fav, favBusy, favPage]);

  const playAt = useCallback(
    (index: number, slug: string) => {
      if (fav && fav.themes.length > 0) {
        startQueue(queueItemsFromSummaries(fav.themes), index, 'watch', 'other');
      }
      // Theme detail, not the player route — the player route is
      // playlist/offline-only (owner ruling 2026-11-10).
      router.push(`/theme/${slug}`);
    },
    [fav, router, startQueue],
  );

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Favourites</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {fixtureMode ? (
          <Text style={styles.emptyText}>
            Demo mode — saved themes live in your account on the live API.
            Nothing is stored here.
          </Text>
        ) : !signedIn ? (
          <View style={styles.promptBody}>
            <View style={styles.tile}>
              <Heart size={26} color={theme.accent} strokeWidth={2} />
            </View>
            <Text style={styles.centerTitle}>Your favourites</Text>
            <Text style={styles.centerNote}>
              Log in to see the themes you have saved.
            </Text>
            <Pressable
              onPress={() => router.push('/login')}
              accessibilityRole="button"
              accessibilityLabel="Log in"
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Log in</Text>
            </Pressable>
          </View>
        ) : favError && !fav ? (
          <View style={styles.promptBody}>
            <Text style={styles.centerNote}>{favError}</Text>
            <Pressable
              onPress={loadFirst}
              accessibilityRole="button"
              accessibilityLabel="Retry"
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : !fav ? (
          /* First load (skeleton sweep): theme-row shapes —
             the list this page is. */
          <>
            {[0, 1, 2, 3, 4].map((i) => (
              <SkeletonThemeRow key={i} />
            ))}
          </>
        ) : (
          <>
            <Text style={styles.countLine}>
              {fav.total} favourite {fav.total === 1 ? 'theme' : 'themes'}
            </Text>
            {fav.themes.map((item, index) => (
              <ThemeRow
                key={item.slug}
                item={item}
                typeChip={false}
                onPress={() => router.push(`/theme/${item.slug}`)}
                onPlay={() => playAt(index, item.slug)}
                saved
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => unsave(item.slug)}
              />
            ))}
            {fav.themes.length === 0 && (
              <Text style={styles.emptyText}>
                No favourites yet — tap the bookmark on any theme to keep
                it here.
              </Text>
            )}
            {favError && <Text style={styles.inlineError}>{favError}</Text>}
            {fav.hasMore && (
              <Pressable
                onPress={loadMore}
                accessibilityRole="button"
                accessibilityLabel="Load more favourite themes"
                style={({ pressed }) => [
                  styles.loadMore,
                  pressed && styles.pressed,
                ]}
              >
                {favBusy ? (
                  <ActivityIndicator size="small" color={theme.muted} />
                ) : (
                  <Text style={styles.loadMoreText}>Load more</Text>
                )}
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    countLine: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    promptBody: {
      alignItems: 'center',
      paddingTop: spacing.xxxl,
      paddingHorizontal: spacing.lg,
    },
    tile: {
      width: 56,
      height: 56,
      borderRadius: radii.md,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    centerTitle: {
      ...typeStyles.heading,
      color: theme.text,
      marginBottom: spacing.xs,
    },
    centerNote: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 19,
      marginBottom: spacing.lg,
    },
    primaryButton: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.xl,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    emptyText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 19,
      marginTop: spacing.md,
    },
    inlineError: {
      ...typeStyles.bodySmall,
      color: theme.danger,
      marginTop: spacing.sm,
    },
    loadMore: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 44,
      marginTop: spacing.md,
    },
    loadMoreText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    pressed: {
      opacity: 0.85,
    },
  });
