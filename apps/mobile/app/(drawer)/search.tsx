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
import { ChevronLeft, Search, X } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { searchThemes } from '../../src/api';
import { ThemeRow } from '../../src/components/ThemeRow';
import { radii, spacing, typeStyles, type Theme } from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Search (DESIGN.md §6.6 + P-16): reached from the header Search icon.
 * One results list under a "Themes" heading — grouping by anime/artist is
 * P-16's fuller structure and is not derivable from the theme-only read
 * path yet. Matching semantics come from src/api.ts (the API's two-stage
 * search, or stage-2 semantics locally in fixture mode).
 *
 * Compact treatment (approved mockup v1): a raised back tile and one
 * rounded search field with the search glyph inside and a clear (×)
 * action while a query is present — clearing is the field's own chrome,
 * the search behaviour underneath is untouched. The mockup's filter
 * (sliders) button and bottom All/OP/ED segmented control are NOT
 * drawn: search has no filter state to attach them to.
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
      <View style={styles.column}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backHit}
          >
            <View style={styles.backTile}>
              <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
            </View>
          </Pressable>
          <View style={styles.field}>
            <Search size={20} color={theme.muted} strokeWidth={2} />
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
            {query.length > 0 && (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={7}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                style={styles.clearButton}
              >
                <X size={16} color={theme.muted} strokeWidth={2} />
              </Pressable>
            )}
          </View>
        </View>

        {query.trim().length === 0 ? (
          <Text style={styles.hint}>Search titles, songs and artists.</Text>
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
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.background,
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  backHit: {
    width: 44,
    height: 48,
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
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
  },
  input: {
    flex: 1,
    ...typeStyles.body,
    color: theme.text,
    paddingVertical: 0,
  },
  clearButton: {
    width: 30,
    height: 30,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
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
