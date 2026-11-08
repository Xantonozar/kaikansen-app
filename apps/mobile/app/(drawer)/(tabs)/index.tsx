import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Shuffle } from 'lucide-react-native';
import type { HomeResponse, ThemeType } from '@kaikansen/contracts';
import { fetchHome, fixtureMode } from '../../../src/api';
import { useFavorites } from '../../../src/favoritesStore';
import { PosterCard } from '../../../src/components/PosterCard';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type TypeFilter = 'ALL' | ThemeType;

/**
 * Home (DESIGN.md §6.4) — the web home composition at phone size:
 * season poster rail → Surprise pill bar → Friends Activity → Popular
 * Themes with the OP/ED filter → the web's end marker. Compact
 * treatment (approved mockup v1): content sits in a centred,
 * width-capped column, and the existing type filter is drawn as a
 * segmented All/OP/ED control in the Popular header row. Data comes
 * from the new API, or from the bundled real-data fixture when no API
 * URL is configured (see src/api.ts).
 */
export default function HomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  useEffect(() => {
    let live = true;
    setHome(null);
    setError(null);
    fetchHome()
      .then((data) => {
        if (live) setHome(data);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : 'Could not load themes.');
        }
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );

  const surprise = useCallback(() => {
    if (!home) return;
    const pool = home.popular.length > 0 ? home.popular : home.seasonRail;
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    openTheme(pick.slug);
  }, [home, openTheme]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Couldn’t load Home.</Text>
        <Text style={styles.errorDetail}>{error}</Text>
        <Pressable
          style={styles.retry}
          onPress={() => setReloadKey((k) => k + 1)}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!home) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.loadingText}>Loading themes…</Text>
      </View>
    );
  }

  const popular =
    typeFilter === 'ALL'
      ? home.popular
      : home.popular.filter((t) => t.type === typeFilter);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.column}>
        {fixtureMode && (
          <Text style={styles.fixtureNote}>
            Fixture mode — showing the bundled catalogue snapshot (no API URL
            configured).
          </Text>
        )}
        {favorites.lastError && (
          <Pressable
            onPress={favorites.clearError}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.saveError}>{favorites.lastError}</Text>
          </Pressable>
        )}

        {/* Season poster rail */}
        <View style={[styles.sectionHeader, styles.sectionHeaderFirst]}>
          <Text style={styles.heading}>
            {home.season.season} {home.season.year}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
        >
          {home.seasonRail.map((item) => (
            <PosterCard
              key={item.slug}
              item={item}
              onPress={() => openTheme(item.slug)}
            />
          ))}
          {home.seasonRail.length === 0 && (
            <Text style={styles.emptyText}>No themes this season yet.</Text>
          )}
        </ScrollView>

        {/* Surprise pill bar */}
        <Pressable
          onPress={surprise}
          style={({ pressed }) => [
            styles.surprise,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Surprise me"
        >
          <Shuffle size={16} color={theme.onAccent} strokeWidth={2} />
          <Text style={styles.surpriseText}>Surprise</Text>
        </Pressable>

        {/* Friends Activity — honest empty state: social data is not part of
            the read-path prototype (no signed-in social graph yet). */}
        <View style={styles.sectionHeader}>
          <Text style={styles.heading}>Friends Activity</Text>
        </View>
        <Text style={styles.emptyText}>
          Nothing here yet — friends activity arrives with sign-in and the
          social slice.
        </Text>

        {/* Popular Themes with the All/OP/ED segmented filter (the existing
            client-side type filter in segmented-control dress; the web
            filters server-side — FR-HOME-01). */}
        <View style={[styles.sectionHeader, styles.popularHeader]}>
          <Text style={styles.heading}>Popular</Text>
          <View style={styles.segmented}>
            {(['ALL', 'OP', 'ED'] as TypeFilter[]).map((value) => {
              const active = typeFilter === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setTypeFilter(value)}
                  hitSlop={{ top: 6, bottom: 6 }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Filter: ${value === 'ALL' ? 'All' : value}`}
                  style={[
                    styles.segment,
                    active && {
                      backgroundColor:
                        value === 'ED' ? theme.tertiary : theme.accent,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && { color: theme.onAccent },
                    ]}
                  >
                    {value === 'ALL' ? 'All' : value}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.list}>
          {popular.map((item) => (
            <ThemeRow
              key={item.slug}
              item={item}
              onPress={() => openTheme(item.slug)}
              saved={favorites.isFavorite(item.slug)}
              savePending={favorites.isPending(item.slug)}
              onToggleSave={() => void favorites.toggle(item.slug)}
            />
          ))}
          {popular.length === 0 && (
            <Text style={styles.emptyText}>No {typeFilter} themes here.</Text>
          )}
        </View>

        {/* The web's own end-of-list marker (DESIGN.md §6.4). */}
        <Text style={styles.endMarker}>
          You’ve reached the end of the hall of fame! ✨
        </Text>
      </View>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: theme.background,
  },
  content: {
    paddingBottom: spacing.xxxl,
  },
  column: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
  },
  loadingText: {
    ...typeStyles.body,
    color: theme.muted,
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
  retry: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typeStyles.body,
    color: theme.text,
  },
  fixtureNote: {
    ...typeStyles.caption,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
  },
  saveError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
    lineHeight: 18,
  },
  sectionHeader: {
    paddingHorizontal: spacing.screenEdge,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sectionHeaderFirst: {
    marginTop: spacing.md,
  },
  heading: {
    ...typeStyles.heading,
    color: theme.text,
  },
  rail: {
    paddingHorizontal: spacing.screenEdge,
    gap: spacing.sm,
  },
  surprise: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.screenEdge,
    marginTop: spacing.lg,
    backgroundColor: theme.accent,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  pressed: {
    opacity: 0.85,
  },
  surpriseText: {
    ...typeStyles.body,
    fontFamily: 'Inter_600SemiBold',
    color: theme.onAccent,
  },
  emptyText: {
    ...typeStyles.body,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    lineHeight: 20,
  },
  popularHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 3,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  segment: {
    minWidth: 44,
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  segmentText: {
    ...typeStyles.caption,
    fontFamily: 'Inter_600SemiBold',
    color: theme.muted,
  },
  list: {
    paddingHorizontal: spacing.screenEdge,
  },
  endMarker: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.screenEdge,
  },
});
