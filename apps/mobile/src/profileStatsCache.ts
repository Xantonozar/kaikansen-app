import type { ProfileStats } from '@kaikansen/contracts';
import { plainStorage } from './storage';

/**
 * Profile-stats instant-display cache (perf problem 4) — the
 * on-device half of the stored-stats work. Both profile screens
 * (the own Profile and the public user profile) paint the LAST
 * stats the app saved for that username the moment they open,
 * then refresh from the API in the background and swap silently
 * when the fresh values land — the accuracy contract is "the
 * paint may be one refresh behind reality"; the server numbers
 * are real-time.
 *
 * Storage is the app's plain (non-secret) AsyncStorage via
 * storage.ts — one JSON record per username under a versioned
 * key: the three aggregate numbers + the last known follow
 * counts + a saved-at timestamp. Tiny and freely evictable:
 * dropping the whole cache only costs the next open its instant
 * paint (the cold-open loading state takes over).
 *
 * Dirty marking: after the app's OWN listen/rate actions, the
 * signed-in user's saved record no longer matches what the API
 * will say, so it is marked dirty — the entry is kept (username
 * + identity of the cache slot) but its stats are dropped, so
 * the next paint waits for the fetch instead of showing numbers
 * the app itself knows are stale. The follow counts ride along
 * untouched: a listen/rate does not move them.
 *
 * The pure record logic (parse / serialize / decide) is split
 * from the storage IO so it unit-tests directly; the store
 * functions below are thin wrappers the screens call.
 */

const KEY_PREFIX = 'kaikansen.profileStats.v1.';

/**
 * Where the signed-in username is remembered between launches
 * (plain storage — a username is not a secret): the dirty
 * marking after the app's own listen/rate actions runs in
 * non-React modules (the playback hook, the API layer) that
 * cannot read the auth context, so they resolve the account
 * through this hint. The AuthProvider keeps it in step with the
 * session (set on sign-in/restore, cleared on sign-out).
 */
const SESSION_USERNAME_KEY = 'kaikansen.sessionUsername';

/** The three stored aggregates plus the follow counts. */
export interface CachedProfileStatsNumbers {
  meanRating: number | null;
  themesListened: number;
  totalListenedSeconds: number;
  followersCount: number;
  followingCount: number;
}

/** One cache record: the numbers + when they were saved. */
export interface ProfileStatsCacheEntry extends CachedProfileStatsNumbers {
  savedAt: number;
}

/** A dirty record: identity + follow counts, stats dropped. */
export interface DirtyProfileStatsEntry {
  dirty: true;
  followersCount: number;
  followingCount: number;
  savedAt: number;
}

export type StoredProfileStatsEntry =
  | ProfileStatsCacheEntry
  | DirtyProfileStatsEntry;

/** The storage key for a username (case-insensitive, like lookups). */
export function profileStatsCacheKey(username: string): string {
  return KEY_PREFIX + username.toLowerCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse a stored JSON record. Anything unrecognised — corrupt
 * JSON, wrong shapes, a mean that is neither number nor null —
 * resolves to null (a cache miss), never a throw: a bad record
 * must behave exactly like no record.
 */
export function parseProfileStatsEntry(
  raw: string | null | undefined,
): StoredProfileStatsEntry | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (
    !isFiniteNumber(d.followersCount) ||
    !isFiniteNumber(d.followingCount) ||
    !isFiniteNumber(d.savedAt)
  ) {
    return null;
  }
  if (d.dirty === true) {
    return {
      dirty: true,
      followersCount: d.followersCount,
      followingCount: d.followingCount,
      savedAt: d.savedAt,
    };
  }
  const meanOk = d.meanRating === null || isFiniteNumber(d.meanRating);
  if (
    !meanOk ||
    !isFiniteNumber(d.themesListened) ||
    !isFiniteNumber(d.totalListenedSeconds)
  ) {
    return null;
  }
  return {
    meanRating: d.meanRating as number | null,
    themesListened: d.themesListened as number,
    totalListenedSeconds: d.totalListenedSeconds as number,
    followersCount: d.followersCount,
    followingCount: d.followingCount,
    savedAt: d.savedAt,
  };
}

/** Serialize a fresh entry from a served ProfileStats payload. */
export function serializeProfileStatsEntry(
  stats: ProfileStats,
  savedAt: number,
): string {
  const entry: ProfileStatsCacheEntry = {
    meanRating: stats.meanRating,
    themesListened: stats.themesListened,
    totalListenedSeconds: stats.totalListenedSeconds,
    followersCount: stats.followersCount,
    followingCount: stats.followingCount,
    savedAt,
  };
  return JSON.stringify(entry);
}

/**
 * Mark an entry dirty: the stats are dropped (they are known
 * stale), the follow counts survive (a listen/rate does not move
 * them), and the record keeps its slot so the screens can still
 * paint the counts line instantly.
 */
export function dirtyProfileStatsEntry(
  entry: ProfileStatsCacheEntry,
  savedAt: number,
): DirtyProfileStatsEntry {
  return {
    dirty: true,
    followersCount: entry.followersCount,
    followingCount: entry.followingCount,
    savedAt,
  };
}

export function isDirtyEntry(
  entry: StoredProfileStatsEntry,
): entry is DirtyProfileStatsEntry {
  return 'dirty' in entry && entry.dirty === true;
}

/**
 * The numbers a screen may PAINT instantly from a stored entry:
 * a clean entry paints its full stats; a dirty entry paints
 * only the follow counts (its stats are known stale); a miss
 * paints nothing. The screens feed the result through the
 * shared src/profileStats formatting exactly like a fresh
 * payload.
 */
export function paintableNumbers(
  entry: StoredProfileStatsEntry | null,
): CachedProfileStatsNumbers | null {
  if (!entry) return null;
  if (isDirtyEntry(entry)) {
    return {
      meanRating: null,
      themesListened: 0,
      totalListenedSeconds: 0,
      followersCount: entry.followersCount,
      followingCount: entry.followingCount,
    };
  }
  return {
    meanRating: entry.meanRating,
    themesListened: entry.themesListened,
    totalListenedSeconds: entry.totalListenedSeconds,
    followersCount: entry.followersCount,
    followingCount: entry.followingCount,
  };
}

/** Whether the entry carries paintable STATS (not just counts). */
export function hasPaintableStats(
  entry: StoredProfileStatsEntry | null,
): boolean {
  return entry !== null && !isDirtyEntry(entry);
}

/* ------------------------------------------------------------------ */
/* Storage IO — thin wrappers over the pure logic above. Every      */
/* failure is swallowed: the cache is an optimisation, never a      */
/* dependency.                                                      */
/* ------------------------------------------------------------------ */

/** Read the saved entry for a username (null on miss/failure). */
export async function readProfileStatsCache(
  username: string,
): Promise<StoredProfileStatsEntry | null> {
  try {
    return parseProfileStatsEntry(
      await plainStorage.get(profileStatsCacheKey(username)),
    );
  } catch {
    return null;
  }
}

/** Save a freshly served stats payload for a username. */
export async function writeProfileStatsCache(
  username: string,
  stats: ProfileStats,
): Promise<void> {
  try {
    await plainStorage.set(
      profileStatsCacheKey(username),
      serializeProfileStatsEntry(stats, Date.now()),
    );
  } catch {
    // A failed write only loses the next open's instant paint.
  }
}

/**
 * Mark the user's saved entry dirty after the app's own
 * listen/rate actions. A missing entry stays missing (nothing to
 * invalidate — the next open fetches anyway); an already-dirty
 * entry stays dirty.
 */
export async function markProfileStatsDirty(username: string): Promise<void> {
  try {
    const key = profileStatsCacheKey(username);
    const entry = parseProfileStatsEntry(await plainStorage.get(key));
    if (!entry || isDirtyEntry(entry)) return;
    await plainStorage.set(
      key,
      JSON.stringify(dirtyProfileStatsEntry(entry, Date.now())),
    );
  } catch {
    // See writeProfileStatsCache — never a dependency.
  }
}

/** Remember (or forget, with null) the signed-in username. */
export async function setSessionUsername(
  username: string | null,
): Promise<void> {
  try {
    if (username) {
      await plainStorage.set(SESSION_USERNAME_KEY, username);
    } else {
      await plainStorage.remove(SESSION_USERNAME_KEY);
    }
  } catch {
    // A lost hint only loses the dirty marking, never correctness.
  }
}

/** The remembered signed-in username (null when signed out). */
export async function getSessionUsername(): Promise<string | null> {
  try {
    return await plainStorage.get(SESSION_USERNAME_KEY);
  } catch {
    return null;
  }
}

/**
 * Mark the SIGNED-IN user's entry dirty — the entry point the
 * app's own listen/rate actions call (they know the action is
 * the account's own; the account itself comes from the session
 * hint). Fire-and-forget by design.
 */
export async function markOwnProfileStatsDirty(): Promise<void> {
  const username = await getSessionUsername();
  if (username) {
    await markProfileStatsDirty(username);
  }
}
