import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { searchThemes } from '../src/api';
import { ThemeRow } from '../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../src/theme';
import { useTheme } from '../src/theme-context';

/**
 * Search (DESIGN.md §6.6 + P-16): reached from the header Search icon.
 * One results list under a "Themes" heading — grouping by anime/artist is
 * P-16's fuller structure and is not derivable from the theme-only read
 * path yet. Matching semantics come from src/api.ts (the API's two-stage
 * search, or stage-2 semantics locally in fixture mode).
 */
export default function SearchScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ThemeSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      searchThemes(q)
        .then((res) => {
          setResults(res.results);
          setError(null);
        })
        .catch((e: unknown) => {
          setResults(null);
          setError(e instanceof Error ? e.message : 'Search failed.');
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Search themes, anime, artists…"
          placeholderTextColor={theme.muted}
          autoFocus
          returnKeyType="search"
          autoCorrect={false}
        />
      </View>

      {query.trim().length === 0 ? (
        <Text style={styles.hint}>
          Start typing to search the catalogue — titles, songs and artists.
        </Text>
      ) : error ? (
        <Text style={styles.hint}>Search failed. {error}</Text>
      ) : searching && results === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : results && results.length === 0 ? (
        <Text style={styles.hint}>No results for “{query.trim()}”.</Text>
      ) : results ? (
        <ScrollView
          style={styles.results}
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.groupHeading}>Themes</Text>
          {results.map((item) => (
            <ThemeRow
              key={item.slug}
              item={item}
              onPress={() => router.push(`/theme/${item.slug}`)}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
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
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  input: {
    flex: 1,
    ...typeStyles.body,
    color: theme.text,
    backgroundColor: theme.surface,
    borderRadius: radii.base,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  hint: {
    ...typeStyles.body,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    lineHeight: 20,
  },
  center: {
    paddingTop: spacing.xxxl,
    alignItems: 'center',
  },
  results: {
    flex: 1,
  },
  resultsContent: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  groupHeading: {
    ...typeStyles.heading,
    color: theme.text,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
});
