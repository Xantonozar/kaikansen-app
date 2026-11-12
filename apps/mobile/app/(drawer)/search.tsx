import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AppImage } from '../../src/components/AppImage';
import { Image as ExpoImage } from '../../src/expoImage';
import type { ImageSource as ExpoImageSource } from 'expo-image';
import { cloudinarySized } from '../../src/imageVariants';
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
  NetworkUser,
  SearchAnimeResult,
  SearchArtistResult,
  SearchResponse,
  ThemeSummary,
} from '@kaikansen/contracts';
import { fetchHome, searchThemes } from '../../src/api';
import { SkeletonThemeRow } from '../../src/components/Skeleton';
import { planSearch, searchMemory } from '../../src/searchMemory';
import { pickDefaultArtist } from '../../src/defaultArtists';
import {
  mergeSearchPage,
  searchResultKeys,
  SEARCH_PAGE_SIZE,
} from '../../src/searchPaging';
import { useFavorites } from '../../src/favoritesStore';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../src/playback-context';
import { getOpenThemesAs } from '../../src/playbackSettings';
import { plainStorage } from '../../src/storage';
import { PersonRow } from '../../src/components/PersonRow';
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
 * The results filter (owner order 2026-11-10): 'all' shows every
 * group GET /search serves; each other key narrows the results to
 * that one group. The chip order is the owner's own — Artists ·
 * Users · Anime · Themes after All.
 */
type SearchFilter = 'all' | 'artists' | 'users' | 'anime' | 'themes';
const FILTERS: { key: SearchFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'artists', label: 'Artists' },
  { key: 'users', label: 'Users' },
  { key: 'anime', label: 'Anime' },
  { key: 'themes', label: 'Themes' },
];

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
      <ExpoImage
        source={{ uri: cloudinarySized(imageUrl, 144) }}
        style={styles.entityDisc}
        contentFit="cover"
        cachePolicy="memory-disk"
        onError={() => setPhotoFailed(true)}
        accessibilityLabel={`${name}'s image`}
      />
    );
  }
  if (!chibiFailed) {
    return (
      <ExpoImage
        source={pickDefaultArtist(slug) as ExpoImageSource}
        style={styles.entityDisc}
        contentFit="cover"
        cachePolicy="memory-disk"
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
 *   artist page), Users (PersonRow — shared Avatar, display name +
 *   @username, chevron → the user profile; the group and the whole
 *   filter row are owner additions 2026-11-10, the mock predates
 *   them). A filter chip row sits above the groups — All ·
 *   Artists · Users · Anime · Themes in the Season chips' pill
 *   language. The All view is the Option B preview (spec
 *   2026-11-10): at most 5 rows per group, the group header
 *   carrying its total and a "View all" affordance when more
 *   exist. A chip — or View all — opens that group's full view:
 *   a virtualised list lazy-loading pages of 15 (GET /search's
 *   group + limit params) with infinite scroll, deduped on the
 *   group's identity key. A view with no matches falls back to
 *   the plain no-results line, never a blank page. The landing state carries no filter row: Recent,
 *   Trending and Popular are not group results. Empty groups are
 *   omitted; fixture mode honestly serves empty anime/artist/user
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
/** The non-'all' filters — each is one full-view group. */
type FullGroup = Exclude<SearchFilter, 'all'>;
type SearchRowItem =
  | ThemeSummary
  | SearchAnimeResult
  | SearchArtistResult
  | NetworkUser;

/** The rows of one group out of a search response. */
function groupRows(res: SearchResponse, group: FullGroup): SearchRowItem[] {
  switch (group) {
    case 'themes':
      return res.results;
    case 'anime':
      return res.anime;
    case 'artists':
      return res.artists;
    case 'users':
      return res.users;
  }
}

/** A row's identity key within its group (dedupe + FlatList keys). */
function itemKey(group: FullGroup, item: SearchRowItem): string {
  switch (group) {
    case 'themes':
      return searchResultKeys.themes(item as ThemeSummary);
    case 'anime':
      return searchResultKeys.anime(item as SearchAnimeResult);
    case 'artists':
      return searchResultKeys.artists(item as SearchArtistResult);
    case 'users':
      return searchResultKeys.users(item as NetworkUser);
  }
}

/** One group's full-view state: pages of 15, appended as the list scrolls. */
interface FullState {
  group: FullGroup;
  items: SearchRowItem[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  failed: boolean;
}

export default function SearchScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const { startQueue } = usePlaybackSession();
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Bumped by the error state's Retry (polish batch): the
     search effect below re-runs the current query through the
     same debounced path. */
  const [attempt, setAttempt] = useState(0);
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
    // A fresh query starts unfiltered — otherwise a chip picked
    // for the last search could hide this one's matches behind
    // the no-results line.
    setFilter('all');
    if (q.length === 0) {
      setResponse(null);
      setSearching(false);
      setError(null);
      return;
    }
    /* Session memory (speed batch, Option B): a remembered
       result for this exact query renders IMMEDIATELY — no
       spinner — while the network fetch still runs below to
       refresh it. A background failure keeps the remembered
       results and never raises the error state; only a
       memory-miss failure surfaces error + Retry. Successful
       fetches are remembered (failures never are). */
    const plan = planSearch(searchMemory, q);
    if (plan.immediate) {
      setResponse(plan.immediate);
      setError(null);
      setSearching(false);
    } else {
      setSearching(true);
    }
    const timer = setTimeout(() => {
      searchThemes(q)
        .then((res) => {
          searchMemory.put(q, res);
          setResponse(res);
          setError(null);
        })
        .catch((e: unknown) => {
          if (plan.fromMemory) {
            // The remembered results stay on screen, silently.
            return;
          }
          setResponse(null);
          setError(e instanceof Error ? e.message : 'Search failed.');
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
    // attempt: the error state's Retry re-runs this same path.
  }, [query, attempt]);

  /* Full view (Option B): a picked chip loads that group's first
     page of 15; onEndReached appends further pages, deduped by
     the group's identity key (searchPaging). A generation counter
     keeps a superseded request (chip switch, query change — which
     also resets the filter to 'all') from landing its rows. */
  const [full, setFull] = useState<FullState | null>(null);
  const fullSeq = useRef(0);

  useEffect(() => {
    if (filter === 'all') {
      fullSeq.current += 1;
      setFull(null);
      return;
    }
    const q = query.trim();
    if (q.length === 0) return;
    const group = filter;
    const seq = ++fullSeq.current;
    setFull({
      group,
      items: [],
      page: 0,
      hasMore: true,
      loading: true,
      loaded: false,
      failed: false,
    });
    searchThemes(q, { group, page: 1, limit: SEARCH_PAGE_SIZE })
      .then((res) => {
        if (fullSeq.current !== seq) return;
        setFull({
          group,
          items: groupRows(res, group),
          page: 1,
          hasMore: res.hasMore,
          loading: false,
          loaded: true,
          failed: false,
        });
      })
      .catch(() => {
        if (fullSeq.current !== seq) return;
        setFull({
          group,
          items: [],
          page: 0,
          hasMore: false,
          loading: false,
          loaded: true,
          failed: true,
        });
      });
  }, [filter, query]);

  const loadMoreFull = () => {
    if (!full || full.loading || !full.hasMore || !full.loaded) return;
    const { group } = full;
    const nextPage = full.page + 1;
    const seq = fullSeq.current;
    setFull({ ...full, loading: true });
    searchThemes(query.trim(), {
      group,
      page: nextPage,
      limit: SEARCH_PAGE_SIZE,
    })
      .then((res) => {
        if (fullSeq.current !== seq) return;
        setFull((prev) =>
          prev && prev.group === group
            ? {
                ...prev,
                items: mergeSearchPage(
                  prev.items,
                  groupRows(res, group),
                  (item) => itemKey(group, item),
                ),
                page: nextPage,
                hasMore: res.hasMore,
                loading: false,
              }
            : prev,
        );
      })
      .catch(() => {
        if (fullSeq.current !== seq) return;
        setFull((prev) => (prev ? { ...prev, loading: false } : prev));
      });
  };

  const playFromList = (items: ThemeSummary[], index: number) => {
    const item = items[index];
    if (!item) return;
    // The row's PLAY DISC (owner ruling 2026-11-12): claim
    // only, no navigation — the song plays in the mini player;
    // the card's own press opens the theme detail. The claim
    // mode is the user's Open-themes-as mode, so the play
    // records as what is actually heard (counts fix RC1).
    startQueue(
      queueItemsFromSummaries(items),
      index,
      getOpenThemesAs(),
      'other',
    );
  };

  const openTheme = (slug: string) => {
    recordRecent(query);
    router.push(`/theme/${slug}`);
  };

  const idle = query.trim().length === 0;
  const results = response?.results ?? [];
  const anime = response?.anime ?? [];
  const artists = response?.artists ?? [];
  const users = response?.users ?? [];
  // The filter narrows which groups render; a group also needs
  // rows to render at all. Spacing follows the VISIBLE groups, so
  // a filtered list keeps the mock's first-group-flush rhythm.
  const showThemes = filter === 'all' || filter === 'themes';
  const showAnime = filter === 'all' || filter === 'anime';
  const showArtists = filter === 'all' || filter === 'artists';
  const showUsers = filter === 'all' || filter === 'users';
  const animeSpaced = showThemes && results.length > 0;
  const artistsSpaced =
    animeSpaced || (showAnime && anime.length > 0);
  const usersSpaced =
    artistsSpaced || (showArtists && artists.length > 0);
  const noVisibleResults =
    response !== null &&
    (!showThemes || results.length === 0) &&
    (!showAnime || anime.length === 0) &&
    (!showArtists || artists.length === 0) &&
    (!showUsers || users.length === 0);

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
        <AppImage source={a.coverImageLarge} style={styles.entityCover} recyclingKey={String(a.anilistId)} />
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

  // People rows are the app's shared unit (PersonRow — the people
  // search's row): shared Avatar, display name + @username.
  const userRow = (u: NetworkUser) => (
    <PersonRow
      key={u.id}
      displayName={u.displayName}
      username={u.username}
      avatarUrl={u.avatarUrl}
      onPress={() => {
        recordRecent(query);
        router.push(`/user/${u.username}`);
      }}
    />
  );

  // The filter row: the Season chips' pattern (content-width
  // pills, flexShrink 0, one-line labels, hidden-scrollbar
  // horizontal scroller; selected = the mauve accent fill).
  const filterChips = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.filterScroll}
    >
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Filter results: ${f.label}`}
              style={({ pressed }) => [
                styles.filterChip,
                active && styles.filterChipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.filterChipText,
                  active && styles.filterChipTextActive,
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );

  // Preview group header: the heading, the group's total, and
  // "View all" while more pages exist (Option B preview rules).
  const groupHeader = (label: string, group: FullGroup) => {
    const meta = response?.groups[group];
    if (!meta) return <Text style={styles.resultHeading}>{label}</Text>;
    return (
      <View style={styles.groupHeaderRow}>
        <Text style={styles.resultHeadingRow}>{label}</Text>
        <View style={styles.groupHeaderSide}>
          <Text style={styles.groupTotal}>{meta.total}</Text>
          {meta.hasMore && (
            <Pressable
              onPress={() => setFilter(group)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`View all ${label}`}
            >
              <Text style={styles.viewAllText}>View all</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  const renderFullRow = (item: SearchRowItem, index: number) => {
    if (filter === 'themes') {
      const t = item as ThemeSummary;
      const items = (full?.items ?? []) as ThemeSummary[];
      return (
        <ThemeRow
          item={t}
          search
          onPress={() => openTheme(t.slug)}
          onPlay={() => playFromList(items, index)}
          saved={favorites.isFavorite(t.slug)}
          savePending={favorites.isPending(t.slug)}
          onToggleSave={() => void favorites.toggle(t.slug)}
        />
      );
    }
    if (filter === 'anime') return animeRow(item as SearchAnimeResult);
    if (filter === 'artists') return artistRow(item as SearchArtistResult);
    if (filter === 'users') return userRow(item as NetworkUser);
    return null;
  };

  // The full view: one group's virtualised list (pages of 15,
  // footer spinner while the next page loads, honest empty and
  // failed states — never a blank page).
  const fullItems =
    full && filter !== 'all' && full.group === filter ? full.items : [];
  const fullViewList = (
    <FlatList
      style={styles.results}
      data={fullItems}
      keyExtractor={(item) => itemKey(filter as FullGroup, item)}
      renderItem={({ item, index }) => renderFullRow(item, index)}
      onEndReached={loadMoreFull}
      onEndReachedThreshold={0.4}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.resultsContent,
        styles.resultsContentResults,
      ]}
      ListHeaderComponent={
        favorites.lastError ? (
          <Pressable
            onPress={favorites.clearError}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.saveError}>{favorites.lastError}</Text>
          </Pressable>
        ) : undefined
      }
      ListFooterComponent={
        full?.loading && fullItems.length > 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        full?.failed ? (
          <Text style={styles.hint}>Search failed. Try again.</Text>
        ) : full?.loaded ? (
          <Text style={styles.hint}>No results for “{query.trim()}”.</Text>
        ) : (
          /* The full view's page-1 load (skeleton sweep):
             theme-row shapes while the first page is in flight. */
          <View>
            {[0, 1, 2, 3, 4].map((i) => (
              <SkeletonThemeRow key={i} />
            ))}
          </View>
        )
      }
    />
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
              /* Idle Popular section loading (skeleton sweep):
                 the section IS theme rows — row shapes stand in
                 under its heading. */
              <>
                <Text style={styles.groupHeading}>Popular right now</Text>
                {[0, 1, 2].map((i) => (
                  <SkeletonThemeRow key={i} />
                ))}
              </>
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
          <View>
            <Text style={styles.hint}>Search failed. {error}</Text>
            <Pressable
              onPress={() => setAttempt((a) => a + 1)}
              accessibilityRole="button"
              accessibilityLabel="Retry search"
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : searching && response === null ? (
          /* Initial results loading (skeleton sweep): the
             results ARE theme rows, so theme-row shapes stand
             in — no page spinner. */
          <View style={styles.resultsSkeleton}>
            {[0, 1, 2, 3, 4].map((i) => (
              <SkeletonThemeRow key={i} />
            ))}
          </View>
        ) : response ? (
          <>
            {filterChips}
            {filter !== 'all' ? (
              fullViewList
            ) : noVisibleResults ? (
              <Text style={styles.hint}>
                No results for “{query.trim()}”.
              </Text>
            ) : (
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
                {showThemes && results.length > 0 && (
                  <View>
                    {groupHeader('Themes', 'themes')}
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
                {showAnime && anime.length > 0 && (
                  <View style={animeSpaced ? styles.groupSpaced : undefined}>
                    {groupHeader('Anime', 'anime')}
                    {anime.map(animeRow)}
                  </View>
                )}
                {showArtists && artists.length > 0 && (
                  <View style={artistsSpaced ? styles.groupSpaced : undefined}>
                    {groupHeader('Artists', 'artists')}
                    {artists.map(artistRow)}
                  </View>
                )}
                {showUsers && users.length > 0 && (
                  <View style={usersSpaced ? styles.groupSpaced : undefined}>
                    {groupHeader('Users', 'users')}
                    {users.map(userRow)}
                  </View>
                )}
              </ScrollView>
            )}
          </>
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
  retryButton: {
    // Home's Retry affordance: bordered chip under the message.
    alignSelf: 'flex-start',
    marginTop: spacing.md,
    marginLeft: spacing.screenEdge,
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
  center: {
    paddingTop: spacing.xxxl,
    alignItems: 'center',
  },
  resultsSkeleton: {
    // The results-loading skeleton's frame (skeleton sweep):
    // the results content's own edge inset + top rhythm.
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
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
  groupHeaderRow: {
    // The Option B preview header: heading left, the group's
    // total + "View all" right, the heading's own mb-2.5 rhythm.
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  resultHeadingRow: {
    // resultHeading without its bottom margin (the row owns it).
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 14,
    letterSpacing: -0.2,
    color: theme.text,
  },
  groupHeaderSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  groupTotal: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  viewAllText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
  },
  groupSpaced: {
    // search-results.html: sections after the first sit mt-3.5
    // (14) below the previous group.
    marginTop: 14,
  },
  filterScroll: {
    // The results filter row (owner, 2026-11-10): the Season
    // chips' scroller, set between the header bar and the groups.
    // flexGrow 0 keeps it at its content height in the column.
    flexGrow: 0,
    marginBottom: spacing.xs,
  },
  filterRow: {
    // The Season chips' row: gap-2 with a breath of vertical
    // padding, inset to the screen edge like the results content.
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
    paddingVertical: 2,
  },
  filterChip: {
    // The Season chips' pill: content-width (flexShrink 0 so the
    // row scrolls instead of squeezing a label), py-1.5 px-3,
    // idle fill = theme.raised.
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: theme.raised,
  },
  filterChipActive: {
    // Selected = the mauve accent fill (Season chipActive).
    backgroundColor: theme.accent,
  },
  filterChipText: {
    // The Season chips' label: text-xs (12), medium idle.
    fontFamily: fontFamilies.caption,
    fontSize: 12,
    color: theme.accent,
  },
  filterChipTextActive: {
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
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
