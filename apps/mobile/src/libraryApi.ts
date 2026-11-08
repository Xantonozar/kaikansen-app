import type {
  CreatePlaylistRequest,
  FavoriteState,
  FavoritesResponse,
  LibraryThemesResponse,
  PlaylistDeletedResponse,
  PlaylistDetail,
  PlaylistsResponse,
  ThemeRatingState,
  UpdatePlaylistRequest,
  WatchHistoryResponse,
} from '@kaikansen/contracts';
import { ApiRequestError, apiJson, fixtureMode } from './api';
import { getAccessToken } from './session';

/**
 * Library client (Slice M2) — favorites, watch history, theme ratings
 * and playlists, over the authenticated fetch in api.ts (the
 * 401-refresh dance lives there). Every endpoint is Bearer-guarded
 * except the single-playlist read, which the API serves publicly,
 * mirroring the web.
 *
 * FIXTURE MODE: there is no API to talk to, so reads resolve the
 * honest empty shapes — a demo library is an empty library, nothing
 * is fabricated — playlist detail resolves null, and writes reject
 * with a demo-mode error the UI can surface verbatim. A guarded write
 * attempted signed-out likewise rejects with a sign-in message
 * instead of leaking a bare 401 to the UI.
 */

const DEMO_WRITE_MESSAGE =
  'Not available in demo mode — connect the app to the API to use your library.';
const SIGN_IN_MESSAGE = 'Log in to use your library.';

function guardWrite(): void {
  if (fixtureMode) throw new Error(DEMO_WRITE_MESSAGE);
  if (!getAccessToken()) throw new Error(SIGN_IN_MESSAGE);
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* Favorites                                                           */
/* ------------------------------------------------------------------ */

export async function fetchFavorites(
  page = 1,
  limit = 50,
): Promise<FavoritesResponse> {
  if (fixtureMode) return { themes: [], total: 0, page, limit, hasMore: false };
  return apiJson<FavoritesResponse>(
    `/library/favorites?page=${page}&limit=${limit}`,
  );
}

export async function addFavorite(slug: string): Promise<FavoriteState> {
  guardWrite();
  return apiJson<FavoriteState>('/library/favorites', {
    method: 'POST',
    body: { slug },
  });
}

export async function removeFavorite(slug: string): Promise<FavoriteState> {
  guardWrite();
  return apiJson<FavoriteState>(`/library/favorites/${enc(slug)}`, {
    method: 'DELETE',
  });
}

/** Exact per-slug saved state (the detail screen's source of truth). */
export async function fetchFavoriteState(
  slug: string,
): Promise<FavoriteState> {
  if (fixtureMode) return { slug, isFavorite: false };
  return apiJson<FavoriteState>(`/library/favorites/${enc(slug)}`);
}

/* ------------------------------------------------------------------ */
/* Watch history                                                       */
/* ------------------------------------------------------------------ */

export async function fetchHistory(): Promise<WatchHistoryResponse> {
  if (fixtureMode) return { entries: [] };
  return apiJson<WatchHistoryResponse>('/library/history');
}

/* ------------------------------------------------------------------ */
/* Library themes (watch history ∪ AniList completed + watching)     */
/* ------------------------------------------------------------------ */

/**
 * GET /library/themes — the web's /api/themes/library union, ported
 * verbatim by the API: catalogue themes the caller has watched or
 * listened to locally UNION themes whose anime is on their AniList
 * COMPLETED + CURRENT (watching) lists (the API deliberately
 * widens the web's completed-only read — planning stays out).
 * Flat and paged on the wire (page 1, limit 50
 * by default, animeSeasonYear desc / animeTitle asc); the AniList
 * segment groups by anime client-side, so this pages through the
 * whole set (100 a page, bounded) and resolves the first page's
 * response shape with every theme filled in. The response's
 * `anilistUser` is the linked AniList username (absent entirely when
 * both sides of the union are empty — the web's early return).
 */
export async function fetchLibraryThemes(): Promise<LibraryThemesResponse> {
  if (fixtureMode) return { themes: [], total: 0, page: 1, limit: 100 };
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 25;
  const first = await apiJson<LibraryThemesResponse>(
    `/library/themes?page=1&limit=${PAGE_LIMIT}`,
  );
  const themes = [...first.themes];
  let page = 1;
  while (themes.length < first.total && page < MAX_PAGES) {
    page += 1;
    const res = await apiJson<LibraryThemesResponse>(
      `/library/themes?page=${page}&limit=${PAGE_LIMIT}`,
    );
    if (res.themes.length === 0) break;
    themes.push(...res.themes);
  }
  return { ...first, themes, page: 1, limit: themes.length };
}

/* ------------------------------------------------------------------ */
/* Ratings                                                             */
/* ------------------------------------------------------------------ */

/**
 * The caller's rating state for a theme. Only meaningful signed-in
 * against the live API — callers gate on that; the fixture guard here
 * keeps a stray call from hitting an undefined base URL.
 */
export async function fetchRatingState(
  slug: string,
): Promise<ThemeRatingState> {
  if (fixtureMode) throw new Error(DEMO_WRITE_MESSAGE);
  return apiJson<ThemeRatingState>(`/themes/${enc(slug)}/rating`);
}

export async function setRating(
  slug: string,
  score: number,
): Promise<ThemeRatingState> {
  guardWrite();
  return apiJson<ThemeRatingState>(`/themes/${enc(slug)}/rating`, {
    method: 'PUT',
    body: { score },
  });
}

export async function clearRating(
  slug: string,
): Promise<ThemeRatingState> {
  guardWrite();
  return apiJson<ThemeRatingState>(`/themes/${enc(slug)}/rating`, {
    method: 'DELETE',
  });
}

/* ------------------------------------------------------------------ */
/* Playlists                                                           */
/* ------------------------------------------------------------------ */

export async function fetchPlaylists(): Promise<PlaylistsResponse> {
  if (fixtureMode) return { playlists: [] };
  return apiJson<PlaylistsResponse>('/playlists');
}

/** Public read — resolves null when the playlist does not exist. */
export async function fetchPlaylist(
  id: string,
): Promise<PlaylistDetail | null> {
  if (fixtureMode) return null;
  try {
    return await apiJson<PlaylistDetail>(`/playlists/${enc(id)}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
}

export async function createPlaylist(
  body: CreatePlaylistRequest,
): Promise<PlaylistDetail> {
  guardWrite();
  return apiJson<PlaylistDetail>('/playlists', { method: 'POST', body });
}

export async function updatePlaylist(
  id: string,
  body: UpdatePlaylistRequest,
): Promise<PlaylistDetail> {
  guardWrite();
  return apiJson<PlaylistDetail>(`/playlists/${enc(id)}`, {
    method: 'PATCH',
    body,
  });
}

export async function deletePlaylist(
  id: string,
): Promise<PlaylistDeletedResponse> {
  guardWrite();
  return apiJson<PlaylistDeletedResponse>(`/playlists/${enc(id)}`, {
    method: 'DELETE',
  });
}

export async function addPlaylistItem(
  id: string,
  slug: string,
): Promise<PlaylistDetail> {
  guardWrite();
  return apiJson<PlaylistDetail>(`/playlists/${enc(id)}/items`, {
    method: 'POST',
    body: { slug },
  });
}

export async function removePlaylistItem(
  id: string,
  slug: string,
): Promise<PlaylistDetail> {
  guardWrite();
  return apiJson<PlaylistDetail>(
    `/playlists/${enc(id)}/items/${enc(slug)}`,
    { method: 'DELETE' },
  );
}
