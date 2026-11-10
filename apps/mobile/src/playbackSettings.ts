import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { PlaybackMode } from '@kaikansen/contracts';

/**
 * Playback preferences (playback plan decision 2) — device-local
 * settings, persisted in plain AsyncStorage like the theme mode
 * (src/theme-context.tsx). Today that is exactly one choice: the
 * mode Theme Detail opens on ("Open themes as: Listen / Watch",
 * default Listen). It is ON-DEVICE ONLY by the owner's ruling —
 * nothing syncs it to the API, and the contracts carry no such
 * field.
 */

const OPEN_MODE_KEY = 'kaikansen.openThemesAs';

/**
 * Resolve the saved open-mode: an unset value — or anything
 * unrecognised — resolves to 'listen' (the plan's default).
 * Pure, so the default rule is unit-tested directly.
 */
export function resolveOpenThemesAs(
  saved: string | null | undefined,
): PlaybackMode {
  return saved === 'watch' ? 'watch' : 'listen';
}

/* Module store (favoritesStore pattern): the Settings screen
   writes, Theme Detail reads, and both stay in step through the
   external store. The in-memory value starts at the default and
   hydrates from storage once per launch. */
let openMode: PlaybackMode = 'listen';
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PlaybackMode {
  return openMode;
}

export function ensurePlaybackSettingsHydrated(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(OPEN_MODE_KEY)
    .then((saved) => {
      openMode = resolveOpenThemesAs(saved);
      hydrated = true;
      emit();
    })
    .catch(() => {
      // A failed read leaves the default standing; the choice
      // simply won't persist across this failure.
      hydrated = true;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** The current open-mode (the default until hydration lands). */
export function getOpenThemesAs(): PlaybackMode {
  return openMode;
}

/** Change the choice: memory first (instant UI), storage behind. */
export function setOpenThemesAs(mode: PlaybackMode): void {
  void ensurePlaybackSettingsHydrated();
  if (openMode === mode) {
    // Still persist — a set before hydration finished must not
    // lose the user's explicit choice to the in-flight read.
    AsyncStorage.setItem(OPEN_MODE_KEY, mode).catch(() => {});
    return;
  }
  openMode = mode;
  emit();
  AsyncStorage.setItem(OPEN_MODE_KEY, mode).catch(() => {});
}

/** React binding for the Settings row + Theme Detail. */
export function useOpenThemesAs(): {
  mode: PlaybackMode;
  setMode: (mode: PlaybackMode) => void;
} {
  void ensurePlaybackSettingsHydrated();
  const mode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { mode, setMode: setOpenThemesAs };
}
