import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ArtistDetailResponse } from '@kaikansen/contracts';
import { fetchArtistDetail } from '../../../src/api';
import { useFavorites } from '../../../src/favoritesStore';
import { Avatar } from '../../../src/components/Avatar';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Artist detail (DESIGN.md §6.9) — artist header (image, name, theme
 * count) and every theme carrying the artist, most-played first.
 * Data: GET /artists/:slug (the web's artist page read, ported).
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

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
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
  const playTheme = useCallback(
    (themeSlug: string) =>
      router.push({ pathname: '/player', params: { slug: themeSlug, mode: 'watch' } }),
    [router],
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
          style={styles.backTile}
        >
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.headerTitle}>Artist</Text>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this artist.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : data === undefined ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
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
              {data.artist.imageUrl ? (
                <Image
                  source={{ uri: data.artist.imageUrl }}
                  style={styles.artistImage}
                />
              ) : (
                <Avatar url={null} name={data.artist.name} size={72} />
              )}
              <Text style={styles.name}>{data.artist.name}</Text>
              {data.artist.aliases.length > 0 && (
                <Text style={styles.aliases}>
                  Also known as {data.artist.aliases.join(', ')}
                </Text>
              )}
              <View style={styles.countChip}>
                <Text style={styles.countChipText}>
                  {data.artist.totalThemes}{' '}
                  {data.artist.totalThemes === 1 ? 'theme' : 'themes'}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionHeading}>Themes</Text>
            {themes.map((item) => (
              <ThemeRow
                key={item.slug}
                item={item}
                onPress={() => openTheme(item.slug)}
                onPlay={() => playTheme(item.slug)}
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
    headerTitle: {
      ...typeStyles.heading,
      color: theme.text,
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
      alignItems: 'center',
      gap: spacing.xs,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    artistImage: {
      width: 72,
      height: 72,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
    },
    name: {
      ...typeStyles.display,
      fontSize: 24,
      color: theme.text,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    aliases: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
    countChip: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      marginTop: spacing.sm,
    },
    countChipText: {
      ...typeStyles.caption,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccentContainer,
    },
    sectionHeading: {
      ...typeStyles.heading,
      fontFamily: 'Inter_600SemiBold',
      color: theme.text,
      marginTop: spacing.xl,
      marginBottom: spacing.md,
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
