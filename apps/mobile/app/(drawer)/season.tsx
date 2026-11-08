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
import { ChevronLeft } from 'lucide-react-native';
import type { HomeResponse, ThemeType } from '@kaikansen/contracts';
import { fetchHome } from '../../src/api';
import { useFavorites } from '../../src/favoritesStore';
import { ThemeRow } from '../../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

type TypeFilter = 'ALL' | ThemeType;

/**
 * Season browse (DESIGN.md §6.5) — Home's "View All": the full season
 * rail as a vertical list with the All/OP/ED filter chips, in the
 * Lavender Dusk treatment. Data is the same /home read Home makes
 * (the rail is the season's full served list, cap 20 server-side).
 */
export default function SeasonScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TypeFilter>('ALL');

  useEffect(() => {
    let live = true;
    fetchHome()
      .then((data) => {
        if (live) setHome(data);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : 'Could not load the season.');
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );
  const playTheme = useCallback(
    (slug: string) =>
      router.push({ pathname: '/player', params: { slug, mode: 'watch' } }),
    [router],
  );

  const themes =
    home && filter !== 'ALL'
      ? home.seasonRail.filter((t) => t.type === filter)
      : (home?.seasonRail ?? []);

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
        <View style={styles.headerMain}>
          <Text style={styles.title}>
            {home ? `${home.season.season} ${home.season.year}` : 'Season'}
          </Text>
          {home && (
            <Text style={styles.subtitle}>
              {home.seasonRail.length} themes this season
            </Text>
          )}
        </View>
      </View>

      <View style={styles.chips}>
        {(['ALL', 'OP', 'ED'] as TypeFilter[]).map((value) => {
          const active = filter === value;
          return (
            <Pressable
              key={value}
              onPress={() => setFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Filter: ${value === 'ALL' ? 'All' : value}`}
              style={[styles.chip, active && { backgroundColor: theme.accent }]}
            >
              <Text
                style={[
                  styles.chipText,
                  active && { color: theme.onAccent },
                ]}
              >
                {value === 'ALL' ? 'All' : value}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this season.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : !home ? (
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
                onPlay={() => playTheme(item.slug)}
                saved={favorites.isFavorite(item.slug)}
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => void favorites.toggle(item.slug)}
              />
            ))}
            {themes.length === 0 && (
              <Text style={styles.emptyText}>
                No {filter === 'ALL' ? '' : `${filter} `}themes this season
                yet.
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
    headerMain: {
      flex: 1,
      gap: 1,
    },
    title: {
      ...typeStyles.display,
      color: theme.text,
    },
    subtitle: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    chips: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    chip: {
      minWidth: 52,
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
    },
    chipText: {
      ...typeStyles.caption,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccentContainer,
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
