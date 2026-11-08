import { useEffect, useSyncExternalStore } from 'react';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fixtureMode } from './api';
import { useAuth } from './auth';
import {
  addFavorite,
  fetchFavorites,
  removeFavorite,
} from './libraryApi';

/**
 * Favorites membership store (Slice M2) — one shared answer to "have
 * I saved this theme?" for every ThemeRow and the detail screen, so a
 * toggle anywhere is reflected everywhere without each screen keeping
 * its own copy. Module-level state (the session.ts pattern) with a
 * useSyncExternalStore binding.
 *
 * Membership loads lazily once a session exists: favorites pages are
 * walked until hasMore is false, capped at MAX_PAGES — beyond the cap
 * the set can miss very old saves (the detail screen's per-slug check
 * stays exact and reconciles via applyFavoriteState). Signing out
 * resets the store.
 *
 * Toggles are optimistic with rollback: the set flips immediately,
 * the API call follows, and a failure restores the previous state and
 * records the message in lastError for whichever screen wants to show
 * it. A per-slug in-flight guard collapses rapid double-taps into one
 * call, so add/remove can never race each other out of order.
 * toggleFavorite never throws — it resolves null on success or the
 * error message on failure.
 */

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

interface FavoritesState {
  slugs: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  loaded: boolean;
  lastError: string | null;
}

const EMPTY: FavoritesState = {
  slugs: new Set<string>(),
  pending: new Set<string>(),
  loaded: false,
  lastError: null,
};

let state: FavoritesState = EMPTY;
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;
/**
 * Toggle outcomes that settled while a membership load was in
 * flight. The load's snapshot can predate them, so its completion
 * overlays these before publishing — otherwise a save made in the
 * first moments after sign-in could flicker back to unsaved.
 */
const settledDuringLoad = new Map<string, boolean>();

function emit(next: Partial<FavoritesState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FavoritesState {
  return state;
}

async function loadAll(force = false): Promise<void> {
  if (fixtureMode) {
    if (!state.loaded) emit({ loaded: true });
    return;
  }
  if (state.loaded && !force) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const slugs = new Set<string>();
      let page = 1;
      for (;;) {
        const res = await fetchFavorites(page, PAGE_SIZE);
        for (const t of res.themes) slugs.add(t.slug);
        if (!res.hasMore || page >= MAX_PAGES) break;
        page += 1;
      }
      for (const [slug, isFavorite] of settledDuringLoad) {
        if (isFavorite) slugs.add(slug);
        else slugs.delete(slug);
      }
      settledDuringLoad.clear();
      emit({ slugs, loaded: true, lastError: null });
    } catch (e) {
      emit({
        lastError:
          e instanceof Error ? e.message : 'Could not load your saved themes.',
      });
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export async function toggleFavorite(slug: string): Promise<string | null> {
  if (state.pending.has(slug)) return null;
  const was = state.slugs.has(slug);
  const flipped = new Set(state.slugs);
  if (was) flipped.delete(slug);
  else flipped.add(slug);
  const pending = new Set(state.pending);
  pending.add(slug);
  emit({ slugs: flipped, pending, lastError: null });
  try {
    const res = was ? await removeFavorite(slug) : await addFavorite(slug);
    if (loadPromise) settledDuringLoad.set(slug, res.isFavorite);
    const settled = new Set(state.slugs);
    if (res.isFavorite) settled.add(slug);
    else settled.delete(slug);
    const nextPending = new Set(state.pending);
    nextPending.delete(slug);
    emit({ slugs: settled, pending: nextPending });
    return null;
  } catch (e) {
    if (loadPromise) settledDuringLoad.set(slug, was);
    const reverted = new Set(state.slugs);
    if (was) reverted.add(slug);
    else reverted.delete(slug);
    const nextPending = new Set(state.pending);
    nextPending.delete(slug);
    const message =
      e instanceof Error ? e.message : 'Could not update your saved themes.';
    emit({ slugs: reverted, pending: nextPending, lastError: message });
    return message;
  }
}

/** Reconcile one slug with an exact server answer (detail screen). */
export function applyFavoriteState(slug: string, isFavorite: boolean): void {
  if (state.slugs.has(slug) === isFavorite) return;
  const slugs = new Set(state.slugs);
  if (isFavorite) slugs.add(slug);
  else slugs.delete(slug);
  emit({ slugs });
}

/** Merge a freshly fetched favorites page into the set (Library). */
export function syncFavoriteSlugs(themes: ThemeSummary[]): void {
  const slugs = new Set(state.slugs);
  let changed = false;
  for (const t of themes) {
    if (!slugs.has(t.slug)) {
      slugs.add(t.slug);
      changed = true;
    }
  }
  if (changed) emit({ slugs, loaded: true });
}

export function resetFavorites(): void {
  loadPromise = null;
  settledDuringLoad.clear();
  state = EMPTY;
  for (const listener of listeners) listener();
}

export interface UseFavorites {
  loaded: boolean;
  lastError: string | null;
  isFavorite: (slug: string) => boolean;
  isPending: (slug: string) => boolean;
  toggle: (slug: string) => Promise<string | null>;
  clearError: () => void;
  reload: () => Promise<void>;
}

/**
 * React binding. Also owns the session lifecycle: membership loads
 * when a session appears and resets when it goes away, whichever
 * screen mounts the hook first.
 */
export function useFavorites(): UseFavorites {
  const { status } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (status === 'signedIn') void loadAll();
    else if (status === 'signedOut') resetFavorites();
  }, [status]);

  return {
    loaded: snap.loaded,
    lastError: snap.lastError,
    isFavorite: (slug: string) => snap.slugs.has(slug),
    isPending: (slug: string) => snap.pending.has(slug),
    toggle: toggleFavorite,
    clearError: () => emit({ lastError: null }),
    reload: () => loadAll(true),
  };
}
