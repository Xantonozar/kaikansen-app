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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
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
import { pickDefaultArtist } from '../../src/defaultArtists';
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
 * The artist row's avatar: the catalogue photo when it is usable
 * (present, not an .svg), else the artist's default chibi, else
 * the initial-letter disc — owner ruling 2026-11-10, superseding
 * the results mock, which drew the letter disc unconditionally.
 * The per-row error state lives here so each row swaps
 * independently, mirroring the artist page's hero swap.
 */
function ArtistRowAvatar({
  imageUrl,
  slug,
  name,
  styles,
}: {
  imageUrl: string | null;
  slug: string;
  name: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const [chibiFailed, setChibiFailed] = useState(false);

  if (
    imageUrl &&
    !imageUrl.toLowerCase().includes('.svg') &&
    !photoFailed
  ) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={styles.entityDisc}
        onError={() => setPhotoFailed(true)}
        accessibilityLabel={`${name}'s image`}
      />
    );
  }
  if (!chibiFailed) {
    return (
      <Image
        source={pickDefaultArtist(slug)}
        style={styles.entityDisc}
        onError={() => setChibiFailed(true)}
        accessibilityLabel={`${name}'s image`}
      />
    );
  }
  return (
    <View style={[styles.entityDisc, styles.discFallback]}>
      <Text style={styles.discInitial}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

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
 *   trends. A section with no data simply doesn't render. The
 *   landing rows carry the mock's bare OP/ED tag beside the
 *   title (ThemeRow's `titleChip` opt-in, from search.html —
 *   badge audit 2026-11-10).
 * - Results: the groups GET /search serves, in the mock's order —
 *   Themes (ThemeRow's `search` variant: 48pt cover, one-line
 *   title, artist + OP/ED chip, play disc + ⋮ — the results mock
 *   draws no heart), Anime (portrait cover, title, year · theme
 *   count, chevron → the anime page), Artists (catalogue photo,
 *   else the artist's default chibi, else the initial-letter disc
 *   — owner ruling 2026-11-10 — name, theme count, chevron → the
 *   artist page). Empty groups are
 *   omitted; fixture mode honestly serves empty anime/artist
 *   groups, so it renders Themes alone. The anime subline omits
 *   the mock's "TV ·" format word: the catalogue stores no format
 *   and the owner declined the backfill (the Anime Detail slice's
 *   standing deviation) — the line is "<year> · <N> themes".
 *   The header bar is shared with the idle state and follows the
 *   results HTML's measurements (plain back arrow, white pill
 *   field), so the idle state's header wears the same cut.
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
    startQueue(queueItemsFromSummaries(items), index, 'watch', 'other');
    // Theme detail, not the player route — the player route is
    // playlist/offline-only (owner ruling 2026-11-10).
    router.push(`/theme/${item.slug}`);
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
      <ChevronRight size={20} color={theme.secondary} strokeWidth={2} />
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
      <ArtistRowAvatar
        imageUrl={ar.imageUrl}
        slug={ar.slug}
        name={ar.name}
        styles={styles}
      />
      <View style={styles.entityMain}>
        <Text style={styles.entityTitle} numberOfLines={1}>
          {ar.name}
        </Text>
        <Text style={styles.entityMeta} numberOfLines={1}>
          {ar.totalThemes} {ar.totalThemes === 1 ? 'theme' : 'themes'}
        </Text>
      </View>
      <ChevronRight size={20} color={theme.secondary} strokeWidth={2} />
    </Pressable>
  );

  // The drawer navigator shows no header, so the screen clears the
  // status bar / notch itself — the sibling drawer screens' pattern
  // (season, anime, artist): SafeAreaView with the top edge. Search
  // shipped with a plain View root, so its header collided with the
  // status bar (owner report 2026-11-10). Bottom needs no edge: the
  // scroll content already pads itself (resultsContent).
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.column}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [
              styles.backButton,
              pressed && styles.pressed,
            ]}
          >
            <ArrowLeft size={22} color={theme.text} strokeWidth={2} />
          </Pressable>
          <View style={styles.field}>
            <Search size={20} color={theme.secondary} strokeWidth={2} />
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
                <X size={18} color={theme.secondary} strokeWidth={2} />
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
                    titleChip
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
            contentContainerStyle={[
              styles.resultsContent,
              styles.resultsContentResults,
            ]}
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
              <View>
                <Text style={styles.resultHeading}>Themes</Text>
                {results.map((item, index) => (
                  <ThemeRow
                    key={item.slug}
                    item={item}
                    search
                    onPress={() => openTheme(item.slug)}
                    onPlay={() => playFromList(results, index)}
                    saved={favorites.isFavorite(item.slug)}
                    savePending={favorites.isPending(item.slug)}
                    onToggleSave={() => void favorites.toggle(item.slug)}
                  />
                ))}
              </View>
            )}
            {anime.length > 0 && (
              <View
                style={results.length > 0 ? styles.groupSpaced : undefined}
              >
                <Text style={styles.resultHeading}>Anime</Text>
                {anime.map(animeRow)}
              </View>
            )}
            {artists.length > 0 && (
              <View
                style={
                  results.length > 0 || anime.length > 0
                    ? styles.groupSpaced
                    : undefined
                }
              >
                <Text style={styles.resultHeading}>Artists</Text>
                {artists.map(artistRow)}
              </View>
            )}
          </ScrollView>
        ) : null}
      </View>
    </SafeAreaView>
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
    // search-results.html: the header row's gap is gap-2.5 (10) —
    // a literal citing the screen's HTML (prior slices' pattern).
    gap: 10,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  backButton: {
    // search-results.html: a plain back arrow in a w-10 h-10 (40)
    // circle — no tile behind it.
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    // search-results.html: the search field is a white pill,
    // px-3.5 py-2 around the input's line — 40 tall, matching
    // the back button's h-10 row.
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 40,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.pill,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    ...typeStyles.body,
    // search-results.html: the typed query is font-semibold.
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    paddingVertical: 0,
  },
  clearButton: {
    // search-results.html: the clear ✕ sits in a w-6 h-6 (24)
    // circle at the field's right end.
    width: 24,
    height: 24,
    borderRadius: radii.pill,
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
  resultsContentResults: {
    // search-results.html: the groups start mt-2 (8) under the
    // header bar.
    paddingTop: spacing.sm,
  },
  resultHeading: {
    // search-results.html: group headings are text-sm (14)
    // semibold, tracking-tight, mb-2.5 (10), px-0.5 (2).
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 14,
    letterSpacing: -0.2,
    color: theme.text,
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  groupSpaced: {
    // search-results.html: sections after the first sit mt-3.5
    // (14) below the previous group.
    marginTop: 14,
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
    // search-results.html (Anime + Artists cards): p-3 (12)
    // padding, rounded-2xl (16) corners, gap-3.5 (14) between the
    // cover/disc and the text, the theme cards' mb-2.5 (10)
    // rhythm between stacked rows.
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: spacing.md,
    minHeight: 56,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    marginBottom: 10,
  },
  entityCover: {
    // search-results.html: the anime poster is w-12 h-16
    // (48×64, portrait), rounded-xl (12).
    width: 48,
    height: 64,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  entityDisc: {
    // search-results.html: the artist disc is w-12 h-12 (48).
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
  },
  discFallback: {
    // search-results.html fills the disc with its lavender-peach
    // (#FCE8E2) — no token carries that hue; the nearest token
    // pair is the warm dangerContainer, and the initial below
    // takes the matching danger (the HTML's peach-text #B05B48
    // maps to the same family). Flagged in the slice report.
    backgroundColor: theme.dangerContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discInitial: {
    // search-results.html: the initial is text-base (16) bold.
    fontFamily: fontFamilies.display,
    fontSize: 16,
    color: theme.danger,
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
    // search-results.html: the subline is 12px in the mauve
    // secondary (#8E5B7B).
    fontFamily: fontFamilies.bodySmall,
    fontSize: 12,
    color: theme.secondary,
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
