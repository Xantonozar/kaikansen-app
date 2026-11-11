import type { HomeResponse, UserProfile } from '@kaikansen/contracts';
import { plainStorage } from './storage';

/**
 * First-paint snapshot (speed batch, owner ruling 2026-11-11 —
 * "disk-persist Home + profile") — the on-device persistence
 * under the problem-5 response cache (src/apiCache.ts). That
 * cache is memory-only by design, so every cold start used to
 * wait on GET /home before Home could paint. This store keeps
 * the LAST successful Home payload + the LAST own-profile
 * payload on disk (plain AsyncStorage, the profileStatsCache
 * pattern); at startup api.ts hydrates them into the memory
 * cache as STALE entries, so the existing stale-while-revalidate
 * path paints them instantly and refreshes in the background —
 * there is deliberately no second refresh path here.
 *
 * Scope: ONE record, stamped with the session scope (a user id,
 * or 'anon') captured when the payloads were served. Hydration
 * serves it ONLY into matching-scope cache keys, and the scope
 * is unknowable until the session resolves — so hydration
 * happens per scope, on the first read under that scope (reads
 * under a wrong scope just miss, like an empty cache). A
 * different account can therefore never be served another
 * account's snapshot: worst case it is ignored on disk until it
 * is overwritten or cleared.
 *
 * Only Home + own-profile ride this store — NOT Library, search,
 * quiz, or other users' profiles (see the spec's scope limit).
 * The friends-activity social exemption is not persisted either.
 *
 * The record logic (serialize / parse / scope decision) is pure
 * so it unit-tests directly; the store functions below are thin
 * IO wrappers whose failures are always swallowed — the snapshot
 * is an optimisation, never a dependency.
 */

const SNAPSHOT_KEY = 'kaikansen.firstPaint.v1';

/** The persisted record: both payloads + fetch times + scope. */
export interface FirstPaintSnapshot {
  scope: string;
  home?: { value: HomeResponse; fetchedAt: number };
  profile?: { value: UserProfile; fetchedAt: number };
}

/** The slice of the snapshot one scope may be served. */
export interface HydratableSnapshot {
  home?: { value: HomeResponse; fetchedAt: number };
  profile?: { value: UserProfile; fetchedAt: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Shape-check one stamped payload slot. Home must carry its two
 * rails + season (the contract's required fields); the profile
 * must carry its identity strings. Anything else is not a
 * payload this build served — treat the slot as absent.
 */
function parseSlot<T>(
  raw: unknown,
  shapeOk: (value: unknown) => boolean,
): { value: T; fetchedAt: number } | undefined {
  if (!isRecord(raw) || !isFiniteNumber(raw.fetchedAt)) return undefined;
  if (!shapeOk(raw.value)) return undefined;
  return { value: raw.value as T, fetchedAt: raw.fetchedAt };
}

function homeShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const season = value.season;
  return (
    isRecord(season) &&
    typeof season.season === 'string' &&
    isFiniteNumber(season.year) &&
    Array.isArray(value.seasonRail) &&
    Array.isArray(value.popular)
  );
}

function profileShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.displayName === 'string'
  );
}

/**
 * Parse a stored snapshot. Corrupt JSON, a missing/blank scope,
 * or slots of the wrong shape resolve to null / dropped slots —
 * never a throw: a bad record behaves exactly like no record.
 */
export function parseFirstPaintSnapshot(
  raw: string | null | undefined,
): FirstPaintSnapshot | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (typeof data.scope !== 'string' || data.scope.length === 0) {
    return null;
  }
  const snapshot: FirstPaintSnapshot = { scope: data.scope };
  const home = parseSlot<HomeResponse>(data.home, homeShapeOk);
  if (home) snapshot.home = home;
  const profile = parseSlot<UserProfile>(data.profile, profileShapeOk);
  if (profile) snapshot.profile = profile;
  if (!snapshot.home && !snapshot.profile) return null;
  return snapshot;
}

/** Serialize a snapshot record (the store's write path). */
export function serializeFirstPaintSnapshot(
  snapshot: FirstPaintSnapshot,
): string {
  return JSON.stringify(snapshot);
}

/**
 * The hydration decision: a snapshot hydrates ONLY into the
 * scope it was captured under. A mismatch yields null — the
 * caller's cache simply stays empty for that read (the record
 * itself is left on disk; it may belong to the scope that signs
 * in next, and logout clears it explicitly).
 */
export function snapshotForScope(
  snapshot: FirstPaintSnapshot | null,
  scope: string,
): HydratableSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.scope !== (scope || 'anon')) return null;
  const out: HydratableSnapshot = {};
  if (snapshot.home) out.home = snapshot.home;
  if (snapshot.profile) out.profile = snapshot.profile;
  return out.home || out.profile ? out : null;
}

/**
 * Merge a freshly served payload into the snapshot under its
 * scope. A scope CHANGE replaces the record outright — the
 * previous account's payloads are dropped, never merged.
 */
export function withServedPayload(
  current: FirstPaintSnapshot | null,
  scope: string,
  patch: {
    home?: { value: HomeResponse; fetchedAt: number };
    profile?: { value: UserProfile; fetchedAt: number };
  },
): FirstPaintSnapshot {
  const base: FirstPaintSnapshot =
    current && current.scope === (scope || 'anon')
      ? { ...current }
      : { scope: scope || 'anon' };
  if (patch.home) base.home = patch.home;
  if (patch.profile) base.profile = patch.profile;
  return base;
}

/* ------------------------------------------------------------------ */
/* Storage IO — thin wrappers. Every failure is swallowed.          */
/* ------------------------------------------------------------------ */

/** Read + parse the stored snapshot (null on miss/corrupt/failure). */
export async function readFirstPaintSnapshot(): Promise<FirstPaintSnapshot | null> {
  try {
    return parseFirstPaintSnapshot(await plainStorage.get(SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

/** Persist a snapshot record. */
export async function writeFirstPaintSnapshot(
  snapshot: FirstPaintSnapshot,
): Promise<void> {
  try {
    await plainStorage.set(
      SNAPSHOT_KEY,
      serializeFirstPaintSnapshot(snapshot),
    );
  } catch {
    // A failed write only loses the next cold open's instant paint.
  }
}

/** Drop the snapshot (logout / account change). */
export async function clearFirstPaintSnapshot(): Promise<void> {
  try {
    await plainStorage.remove(SNAPSHOT_KEY);
  } catch {
    // Nothing depends on the clear landing.
  }
}
