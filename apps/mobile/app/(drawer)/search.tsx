import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Search,
  X,
} from 'lucide-react-native';
import type {
  SearchAnimeResult,
  SearchArtistResult,
  SearchResponse,
  ThemeSummary,
} from '@kaikansen/contracts';
import { fetchHome, searchThemes } from '../../src/api';
import { useFavorites } from '../../src/favoritesStore';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../src/playback-context';
import { plainStorage } from '../../src/storage';
import { ThemeRow } from '../../src/components/ThemeRow';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

const RECENTS_KEY = 'kaikansen.recentSearches.v1';
const RECENTS_CAP = 8;

/**
 * Search (DESIGN.md §6.6, Lavender Dusk finals — idle
 * `131adb5343294f038e68a7c53b65a68a`, results
 * `d2802dbad2654b6dbe168928ec4aec6d`): reached from the header
 * Search icon. Two states, both drawn from the mocks:
 *
 * - Idle (no query): Recent searches (this device's own history,
 *   AsyncStorage via storage.ts — most-recent-first, per-row
 *   remove, Clear wipes all), Trending chips, and "Popular right
 *   now". The last two are fed by ONE real read — GET /home's
 *   popular rail (fetchHome): the rows are that rail, and the
 *   chips are the anime titles and artist names those popular
 *   themes carry, deduped — real catalogue data, no invented
 *   trends. A section with no data simply doesn't render.
 * - Results: the groups GET /search serves, in the mock's order —
 *   Themes (ThemeRows, as everywhere), Anime (cover, title,
 *   year · theme count, chevron → the anime page), Artists
 *   (image or initial disc, name, theme count, chevron → the
 *   artist page). Empty groups are omitted; fixture mode honestly
 *   serves empty anime/artist groups, so it renders Themes alone.
 *
 * A search is recorded in Recent when it is submitted (keyboard
 * search key), picked from a chip/recent row, or when a result is
 * opened — never per keystroke, so partial queries don't pollute
 * the list. Row play claims the shown list as the queue and opens
 * the player, exactly like Home's Popular and the Playlist rows.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const { startQueue } = usePlaybackSession();
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [popular, setPopular] = useState<ThemeSummary[] | null>(null);

  /* Recent searches — device-local, restored on mount. */
  useEffect(() => {
    let live = true;
    plainStorage
      .get(RECENTS_KEY)
      .then((raw) => {
        if (!live || !raw) return;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            setRecents(
              parsed.filter(
                (x): x is string => typeof x === 'string' && x.length > 0,
              ).slice(0, RECENTS_CAP),
            );
          }
        } catch {
          // A corrupt local list is worth nothing — start clean.
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const saveRecents = (next: string[]) => {
    setRecents(next);
    void plainStorage.set(RECENTS_KEY, JSON.stringify(next)).catch(() => {});
  };

  const recordRecent = (raw: string) => {
    const q = raw.trim();
    if (q.length === 0) return;
    saveRecents(
      [q, ...recents.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(
        0,
        RECENTS_CAP,
      ),
    );
  };

  /** Run a search picked from a chip / recent row: fill the field
      (the debounced read below does the rest) and record it. */
  const runPickedQuery = (q: string) => {
    setQuery(q);
    recordRecent(q);
  };

  /* Idle data: the /home popular rail feeds both Trending and
     "Popular right now". A failed read leaves the section out —
     the search field is the screen's reason to exist. */
  useEffect(() => {
    let live = true;
    fetchHome()
      .then((home) => {
        if (live) setPopular(home.popular);
      })
      .catch(() => {
        if (live) setPopular([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const trending = useMemo(() => {
    if (!popular) return [];
    const seen = new Set<string>();
    const chips: string[] = [];
    for (const t of popular) {
      const artist = t.artistName ?? t.allArtists[0] ?? null;
      for (const candidate of [t.animeTitleEnglish ?? t.animeTitle, artist]) {
        if (!candidate) continue;
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        chips.push(candidate);
        if (chips.length >= 8) return chips;
      }
    }
    return chips;
  }, [popular]);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResponse(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      searchThemes(q)
        .then((res) => {
          setResponse(res);
          setError(null);
        })
        .catch((e: unknown) => {
          setResponse(null);
          setError(e instanceof Error ? e.message : 'Search failed.');
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const playFromList = (items: ThemeSummary[], index: number) => {
    const item = items[index];
    if (!item) return;
    startQueue(queueItemsFromSummaries(items), index, 'watch');
    router.push({
      pathname: '/player',
      params: { slug: item.slug, mode: 'watch' },
    });
  };

  const openTheme = (slug: string) => {
    recordRecent(query);
    router.push(`/theme/${slug}`);
  };

  const idle = query.trim().length === 0;
  const results = response?.results ?? [];
  const anime = response?.anime ?? [];
  const artists = response?.artists ?? [];
  const noResults =
    response !== null &&
    results.length === 0 &&
    anime.length === 0 &&
    artists.length === 0;

  const animeRow = (a: SearchAnimeResult) => (
    <Pressable
      key={a.anilistId}
      onPress={() => {
        recordRecent(query);
        router.push(`/anime/${a.anilistId}`);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open ${a.titleEnglish ?? a.titleRomaji}`}
      style={({ pressed }) => [styles.entityRow, pressed && styles.pressed]}
    >
      {a.coverImageLarge ? (
        <Image source={{ uri: a.coverImageLarge }} style={styles.entityCover} />
      ) : (
        <View style={[styles.entityCover, styles.placeholder]} />
      )}
      <View style={styles.entityMain}>
        <Text style={styles.entityTitle} numberOfLines={1}>
          {a.titleEnglish ?? a.titleRomaji}
        </Text>
        <Text style={styles.entityMeta} numberOfLines={1}>
          {a.seasonYear ? `${a.seasonYear} · ` : ''}
          {a.themeCount} {a.themeCount === 1 ? 'theme' : 'themes'}
        </Text>
      </View>
      <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
    </Pressable>
  );

  const artistRow = (ar: SearchArtistResult) => (
    <Pressable
      key={ar.slug}
      onPress={() => {
        recordRecent(query);
        router.push(`/artist/${ar.slug}`);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open ${ar.name}`}
      style={({ pressed }) => [styles.entityRow, pressed && styles.pressed]}
    >
      {ar.imageUrl ? (
        <Image source={{ uri: ar.imageUrl }} style={styles.entityDisc} />
      ) : (
        <View style={[styles.entityDisc, styles.discFallback]}>
          <Text style={styles.discInitial}>
            {ar.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.entityMain}>
        <Text style={styles.entityTitle} numberOfLines={1}>
          {ar.name}
        </Text>
        <Text style={styles.entityMeta} numberOfLines={1}>
          {ar.totalThemes} {ar.totalThemes === 1 ? 'theme' : 'themes'}
        </Text>
      </View>
      <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
    </Pressable>
  );

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
              placeholder="Search anime, songs, artists…"
              placeholderTextColor={theme.muted}
              autoFocus
              returnKeyType="search"
              autoCorrect={false}
              onSubmitEditing={() => recordRecent(query)}
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

        {idle ? (
          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="handled"
          >
            {recents.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={styles.groupHeading}>Recent</Text>
                  <Pressable
                    onPress={() => saveRecents([])}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Clear recent searches"
                  >
                    <Text style={styles.clearText}>Clear</Text>
                  </Pressable>
                </View>
                {recents.map((r) => (
                  <View key={r} style={styles.recentRow}>
                    <Pressable
                      onPress={() => runPickedQuery(r)}
                      accessibilityRole="button"
                      accessibilityLabel={`Search ${r} again`}
                      style={({ pressed }) => [
                        styles.recentMain,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Clock size={16} color={theme.muted} strokeWidth={2} />
                      <Text style={styles.recentText} numberOfLines={1}>
                        {r}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        saveRecents(recents.filter((x) => x !== r))
                      }
                      hitSlop={7}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${r} from recent searches`}
                      style={styles.recentRemove}
                    >
                      <X size={15} color={theme.muted} strokeWidth={2} />
                    </Pressable>
                  </View>
                ))}
              </>
            )}

            {trending.length > 0 && (
              <>
                <Text style={styles.groupHeading}>Trending</Text>
                <View style={styles.chipWrap}>
                  {trending.map((chip) => (
                    <Pressable
                      key={chip}
                      onPress={() => runPickedQuery(chip)}
                      accessibilityRole="button"
                      accessibilityLabel={`Search ${chip}`}
                      style={({ pressed }) => [
                        styles.chip,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.chipText}>{chip}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            {popular === null ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : popular.length > 0 ? (
              <>
                <Text style={styles.groupHeading}>Popular right now</Text>
                {favorites.lastError && (
                  <Pressable
                    onPress={favorites.clearError}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                  >
                    <Text style={styles.saveError}>{favorites.lastError}</Text>
                  </Pressable>
                )}
                {popular.map((item, index) => (
                  <ThemeRow
                    key={item.slug}
                    item={item}
                    onPress={() => router.push(`/theme/${item.slug}`)}
                    onPlay={() => playFromList(popular, index)}
                    saved={favorites.isFavorite(item.slug)}
                    savePending={favorites.isPending(item.slug)}
                    onToggleSave={() => void favorites.toggle(item.slug)}
                  />
                ))}
              </>
            ) : recents.length === 0 && trending.length === 0 ? (
              <Text style={styles.hint}>
                Search titles, songs and artists.
              </Text>
            ) : null}
          </ScrollView>
        ) : error ? (
          <Text style={styles.hint}>Search failed. {error}</Text>
        ) : searching && response === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : noResults ? (
          <Text style={styles.hint}>No results for “{query.trim()}”.</Text>
        ) : response ? (
          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="handled"
          >
            {favorites.lastError && (
              <Pressable
                onPress={favorites.clearError}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
              >
                <Text style={styles.saveError}>{favorites.lastError}</Text>
              </Pressable>
            )}
            {results.length > 0 && (
              <>
                <Text style={styles.groupHeading}>Themes</Text>
                {results.map((item, index) => (
                  <ThemeRow
                    key={item.slug}
                    item={item}
                    onPress={() => openTheme(item.slug)}
                    onPlay={() => playFromList(results, index)}
                    saved={favorites.isFavorite(item.slug)}
                    savePending={favorites.isPending(item.slug)}
                    onToggleSave={() => void favorites.toggle(item.slug)}
                  />
                ))}
              </>
            )}
            {anime.length > 0 && (
              <>
                <Text style={styles.groupHeading}>Anime</Text>
                {anime.map(animeRow)}
              </>
            )}
            {artists.length > 0 && (
              <>
                <Text style={styles.groupHeading}>Artists</Text>
                {artists.map(artistRow)}
              </>
            )}
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
    // Mock: white circular back button.
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    // Mock: the search field is a white pill.
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.pill,
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clearText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  recentMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingVertical: spacing.xs,
  },
  recentText: {
    ...typeStyles.body,
    color: theme.text,
    flex: 1,
  },
  recentRemove: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    // Trending chips are OUTLINED pills in the mock (design
    // polish pass) — transparent fill, hairline border; the
    // content stays data-driven from the popular rail (the
    // mock's fixed story set is illustrative).
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  entityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    minHeight: 56,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.card,
    marginBottom: spacing.sm,
  },
  entityCover: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
  },
  entityDisc: {
    width: 52,
    height: 52,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
  },
  discFallback: {
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discInitial: {
    ...typeStyles.heading,
    color: theme.onAccentContainer,
  },
  placeholder: {
    backgroundColor: theme.raised,
  },
  entityMain: {
    flex: 1,
    gap: 2,
  },
  entityTitle: {
    ...typeStyles.body,
    fontSize: 14,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  entityMeta: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  saveError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },
});
