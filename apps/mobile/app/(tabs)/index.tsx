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
import { fetchHome, fixtureMode } from '../../src/api';
import { PosterCard } from '../../src/components/PosterCard';
import { ThemeRow } from '../../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../../src/theme';
import { useTheme } from '../../src/theme-context';

type TypeFilter = 'ALL' | ThemeType;

/**
 * Home (DESIGN.md §6.4) — the web home composition at phone size:
 * season poster rail → Surprise pill bar → Friends Activity →
 * 🔥 Popular Themes with the OP/ED pill filter → the web's end marker.
 * Data comes from the new API, or from the bundled real-data fixture when
 * no API URL is configured (see src/api.ts).
 */
export default function HomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
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
      {fixtureMode && (
        <Text style={styles.fixtureNote}>
          Fixture mode — showing the bundled catalogue snapshot (no API URL
          configured).
        </Text>
      )}

      {/* Season poster rail */}
      <View style={styles.sectionHeader}>
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
      >
        <Shuffle size={18} color={theme.onAccent} strokeWidth={2} />
        <Text style={styles.surpriseText}>Surprise me</Text>
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

      {/* Popular Themes with the OP/ED pill filter (client-side in the
          prototype; the web filters server-side — FR-HOME-01). */}
      <View style={styles.sectionHeader}>
        <Text style={styles.heading}>🔥 Popular Themes</Text>
      </View>
      <View style={styles.filterRow}>
        {(['ALL', 'OP', 'ED'] as TypeFilter[]).map((value) => {
          const active = typeFilter === value;
          return (
            <Pressable
              key={value}
              onPress={() => setTypeFilter(value)}
              style={[
                styles.pill,
                active && {
                  backgroundColor:
                    value === 'ED' ? theme.tertiary : theme.accent,
                  borderColor:
                    value === 'ED' ? theme.tertiary : theme.accent,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  active && { color: theme.onAccent },
                ]}
              >
                {value === 'ALL' ? 'All' : value}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View>
        {popular.map((item) => (
          <ThemeRow
            key={item.slug}
            item={item}
            onPress={() => openTheme(item.slug)}
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
  sectionHeader: {
    paddingHorizontal: spacing.screenEdge,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  heading: {
    ...typeStyles.heading,
    color: theme.text,
  },
  rail: {
    paddingHorizontal: spacing.screenEdge,
    gap: spacing.md,
  },
  surprise: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.screenEdge,
    marginTop: spacing.xxl,
    backgroundColor: theme.accent,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
  },
  pressed: {
    opacity: 0.85,
  },
  surpriseText: {
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  emptyText: {
    ...typeStyles.body,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    lineHeight: 20,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
    marginBottom: spacing.sm,
  },
  pill: {
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
  },
  pillText: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  endMarker: {
    ...typeStyles.body,
    color: theme.muted,
    textAlign: 'center',
    marginTop: spacing.xxxl,
    paddingHorizontal: spacing.screenEdge,
  },
});
