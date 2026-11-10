import type {
  FollowState,
  FriendsActivityResponse,
  MarkNotificationsReadResponse,
  NetworkResponse,
  NotificationsResponse,
  PlaylistsResponse,
  ThemeComment,
  ThemeCommentsResponse,
  UpdateProfileRequest,
  UserActivityResponse,
  UserHistoryResponse,
  UserProfile,
  UserPublicProfile,
  PlayerRankSummary,
  RankLeaderboardResponse,
  UserRankProfile,
  UserRatingsResponse,
  UserSearchResponse,
  UserStats,
} from '@kaikansen/contracts';
import { apiJson, fixtureMode } from './api';
import { demoUpdateProfile } from './demoAuth';
import { getAccessToken } from './session';

/**
 * Social client (Slice M5) — profiles, follows, the friends-activity
 * feed, people search, theme comments, notifications, rank chips and
 * the profile edit, over the authenticated fetch in api.ts (the
 * 401-refresh dance lives there; optional-auth endpoints simply ride
 * it anonymously when signed out). Mirrors libraryApi.ts's fixture
 * contract:
 *
 * FIXTURE MODE: there is no API to talk to and demo mode fabricates
 * NO people, activity or comments — list reads resolve the honest
 * empty shapes, single-profile reads reject with a demo message the
 * screen renders as its demo state, and writes reject with a
 * demo-mode error the UI can surface verbatim. A guarded write
 * attempted signed-out likewise rejects with a sign-in message
 * instead of leaking a bare 401 to the UI.
 */

const DEMO_READ_MESSAGE =
  'Not available in demo mode — connect the app to the API to browse profiles.';
const DEMO_WRITE_MESSAGE =
  'Not available in demo mode — connect the app to the API to do that.';
const SIGN_IN_MESSAGE = 'Log in first.';

function guardWrite(): void {
  if (fixtureMode) throw new Error(DEMO_WRITE_MESSAGE);
  if (!getAccessToken()) throw new Error(SIGN_IN_MESSAGE);
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* Friends-activity feed + people search                               */
/* ------------------------------------------------------------------ */

export async function fetchFriendsActivity(
  limit = 30,
): Promise<FriendsActivityResponse> {
  if (fixtureMode) return { activities: [], isGlobal: false };
  return apiJson<FriendsActivityResponse>(
    `/social/friends-activity?limit=${limit}`,
  );
}

export async function searchUsers(
  query: string,
  page = 1,
): Promise<UserSearchResponse> {
  const q = query.trim();
  if (fixtureMode) return { query: q, users: [], page, total: 0, hasMore: false };
  return apiJson<UserSearchResponse>(
    `/social/users/search?q=${enc(q)}&page=${page}`,
  );
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

/** Public profile — rejects (404 demo message / API error) when unknown. */
export async function fetchUserProfile(
  username: string,
): Promise<UserPublicProfile> {
  if (fixtureMode) throw new Error(DEMO_READ_MESSAGE);
  return apiJson<UserPublicProfile>(`/users/${enc(username)}`);
}

export async function fetchUserStats(username: string): Promise<UserStats> {
  if (fixtureMode) throw new Error(DEMO_READ_MESSAGE);
  return apiJson<UserStats>(`/users/${enc(username)}/stats`);
}

export async function fetchUserNetwork(
  username: string,
): Promise<NetworkResponse> {
  if (fixtureMode) throw new Error(DEMO_READ_MESSAGE);
  return apiJson<NetworkResponse>(`/users/${enc(username)}/network`);
}

/**
 * The owner's recent ratings + watches. Privacy-gated server-side:
 * anyone the gate excludes (and every anonymous caller who isn't the
 * owner) receives an empty list — the screen phrases that case, it
 * never invents rows.
 */
export async function fetchUserActivity(
  username: string,
): Promise<UserActivityResponse> {
  if (fixtureMode) return { activity: [] };
  return apiJson<UserActivityResponse>(`/users/${enc(username)}/activity`);
}

export async function fetchUserRatings(
  username: string,
): Promise<UserRatingsResponse> {
  if (fixtureMode) return { ratings: [] };
  return apiJson<UserRatingsResponse>(`/users/${enc(username)}/ratings`);
}

export async function fetchUserHistory(
  username: string,
): Promise<UserHistoryResponse> {
  if (fixtureMode)
    return { entries: [], meta: { total: 0, localCount: 0, remoteCount: 0, merged: false } };
  return apiJson<UserHistoryResponse>(`/users/${enc(username)}/history`);
}

/**
 * The user's PUBLIC playlists for their profile's Playlists
 * section (GET /users/:username/playlists — the API lists public
 * ones only, so every row is safe to show a visitor). Fixture mode
 * fabricates no people, so the section simply stays hidden.
 */
export async function fetchUserPlaylists(
  username: string,
): Promise<PlaylistsResponse> {
  if (fixtureMode) return { playlists: [] };
  return apiJson<PlaylistsResponse>(`/users/${enc(username)}/playlists`);
}

/** A user's rank document (public read) — used for the profile chip. */
export async function fetchUserRank(userId: string): Promise<UserRankProfile> {
  if (fixtureMode) throw new Error(DEMO_READ_MESSAGE);
  return apiJson<UserRankProfile>(`/rank/${enc(userId)}`);
}

/** The signed-in caller's own rank document (GET /rank/me). */
export async function fetchMyRank(): Promise<UserRankProfile> {
  if (fixtureMode) throw new Error(DEMO_READ_MESSAGE);
  return apiJson<UserRankProfile>('/rank/me');
}

/**
 * Batched player rank standings (GET /rank/players) — the quiz
 * room roster's tier + RP sublines (layout-fidelity Slice 6). The
 * endpoint is read-only and reports academy / 0 RP for players
 * without a rank document. Fixture mode resolves an empty map:
 * demo mode has no rooms, so there is no roster to enrich.
 */
export async function fetchPlayerRanks(
  userIds: string[],
): Promise<Map<string, PlayerRankSummary>> {
  if (fixtureMode || userIds.length === 0) return new Map();
  const res = await apiJson<{ players: PlayerRankSummary[] }>(
    `/rank/players?ids=${userIds.map((id) => encodeURIComponent(id)).join(',')}`,
  );
  return new Map(res.players.map((p) => [p.userId, p]));
}

/**
 * The RP leaderboard (GET /rank/leaderboard) — the web's top 100 by
 * RP, all-time (the API has no period parameter; see rankUtil).
 * Fixture mode answers the honest empty board, like the quiz board.
 */
export async function fetchRankLeaderboard(): Promise<RankLeaderboardResponse> {
  if (fixtureMode)
    return { leaderboard: [], meta: { source: 'live', computedAt: null } };
  return apiJson<RankLeaderboardResponse>('/rank/leaderboard');
}

/* ------------------------------------------------------------------ */
/* Follows                                                             */
/* ------------------------------------------------------------------ */

export async function fetchFollowState(
  username: string,
): Promise<FollowState> {
  if (fixtureMode) return { username, isFollowing: false };
  return apiJson<FollowState>(`/users/${enc(username)}/follow`);
}

export async function followUser(username: string): Promise<FollowState> {
  guardWrite();
  return apiJson<FollowState>(`/users/${enc(username)}/follow`, {
    method: 'POST',
  });
}

export async function unfollowUser(username: string): Promise<FollowState> {
  guardWrite();
  return apiJson<FollowState>(`/users/${enc(username)}/follow`, {
    method: 'DELETE',
  });
}

/* ------------------------------------------------------------------ */
/* Theme comments                                                      */
/* ------------------------------------------------------------------ */

export async function fetchComments(
  slug: string,
): Promise<ThemeCommentsResponse> {
  if (fixtureMode) return { comments: [] };
  return apiJson<ThemeCommentsResponse>(`/themes/${enc(slug)}/comments`);
}

export async function postComment(
  slug: string,
  content: string,
): Promise<ThemeComment> {
  guardWrite();
  return apiJson<ThemeComment>(`/themes/${enc(slug)}/comments`, {
    method: 'POST',
    body: { content },
  });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export async function fetchNotifications(): Promise<NotificationsResponse> {
  if (fixtureMode) return { notifications: [] };
  return apiJson<NotificationsResponse>('/notifications');
}

/**
 * Mark read: with an id list, only those (of the caller's own) are
 * marked; with no list, ALL of the caller's unread are marked — the
 * web's body semantics, mirrored.
 */
export async function markNotificationsRead(
  notificationIds?: string[],
): Promise<MarkNotificationsReadResponse> {
  guardWrite();
  return apiJson<MarkNotificationsReadResponse>('/notifications/mark-read', {
    method: 'POST',
    body: notificationIds ? { notificationIds } : {},
  });
}

/* ------------------------------------------------------------------ */
/* Profile edit                                                        */
/* ------------------------------------------------------------------ */

/**
 * PATCH /auth/me — resolves the full updated profile. In fixture
 * mode the edit lands on the device-local demo account instead
 * (demoAuth), so the demo Settings form works end to end and is
 * labelled as demo everywhere it matters.
 */
export async function updateMyProfile(
  body: UpdateProfileRequest,
): Promise<UserProfile> {
  if (fixtureMode) return demoUpdateProfile(body);
  return apiJson<UserProfile>('/auth/me', { method: 'PATCH', body });
}
