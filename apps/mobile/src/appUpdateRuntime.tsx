import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { getContentUriAsync } from 'expo-file-system/legacy';
import type { AppVersionResponse } from '@kaikansen/contracts';
import { apiBaseUrl, fetchWithDeadline, fixtureMode } from './api';
import { plainStorage } from './storage';
import {
  UPDATE_SNOOZE_KEY,
  UPDATE_SNOOZE_MS,
  parseUpdateSnooze,
  updateReducer,
  type UpdateState,
} from './appUpdate';

/**
 * In-app update runtime (release readiness, 2026-11-11) — the
 * IMPURE half of the update feature: the check fetch, the snooze
 * storage, the APK download and the installer hand-off. All
 * decisions live in the pure appUpdate.ts; this module only moves
 * bytes and reports events into the reducer.
 *
 * CHECK: GET /app/version fetched DIRECTLY (fetchWithDeadline,
 * the fetchThemeBySlug precedent) — never through the app cache:
 * a cached "latest" would defeat the check's purpose. The check
 * runs once per launch (root layout, post-first-paint, silent on
 * failure: CHECK_FAILED settles the machine to `checkFailed`,
 * which the home prompt never renders) and again when the About
 * screen asks — About's ask FORCES a fresh check whatever the
 * last outcome was (see check's options below). Fixture mode
 * has no API — no check.
 *
 * INSTALLED FACTS: marketing version from
 * `Constants.expoConfig.version`, build number from
 * `Constants.expoConfig.android.versionCode` (expo-constants
 * documents it as exactly "the version code set by
 * android.versionCode in app.json").
 *
 * DOWNLOAD + INSTALL (mechanism record): the APK downloads with
 * the downloads store's own machinery —
 * `createDownloadResumable` from expo-file-system/legacy — into
 * the CACHE directory (`Paths.cache/app-update/`), NOT the theme
 * downloads store: an update is not library content, it never
 * enters the index, and the file is deleted after the installer
 * attempt (the cache dir is OS-reclaimable regardless). Progress
 * is the resumable callback's real byte fraction.
 *
 * The installer opens through expo-intent-launcher (added for
 * this batch, ~58.0.1 — the one new native dep): the downloaded
 * file's `content://` URI comes from expo-file-system/legacy's
 * `getContentUriAsync` (already a dependency — no second file
 * package needed), then `startActivityAsync('android.intent.
 * action.VIEW', { data: contentUri, type:
 * 'application/vnd.android.package-archive', flags: 1 })` —
 * flags 1 = FLAG_GRANT_READ_URI_PERMISSION, so the installer may
 * read the file. Android then shows its own install confirmation:
 * the one tap sideloading cannot skip. If any of this throws, the
 * card lands in the error state with a "Download in browser
 * instead" fallback (the component opens apkUrl).
 */

export interface InstalledBuild {
  version: string;
  versionCode: number;
}

export function installedBuild(): InstalledBuild {
  return {
    version: Constants.expoConfig?.version ?? '0.0.0',
    versionCode: Constants.expoConfig?.android?.versionCode ?? 0,
  };
}

/** The direct, uncached release-facts fetch. Null = check failed. */
export async function fetchAppVersion(): Promise<AppVersionResponse | null> {
  if (fixtureMode || !apiBaseUrl) return null;
  try {
    const res = await fetchWithDeadline(`${apiBaseUrl}/app/version`, {
      method: 'GET',
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as Partial<AppVersionResponse>;
    if (
      typeof payload.latestVersion !== 'string' ||
      typeof payload.latestVersionCode !== 'number' ||
      typeof payload.apkUrl !== 'string' ||
      typeof payload.minSupportedVersionCode !== 'number' ||
      !Array.isArray(payload.notes)
    ) {
      return null;
    }
    return payload as AppVersionResponse;
  } catch {
    return null;
  }
}

const UpdateContext = createContext<{
  state: UpdateState;
  check: (options?: { force?: boolean }) => void;
  pressUpdate: () => void;
  pressLater: () => void;
} | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const checkingRef = useRef(false);
  // Launch auto-check memory: the plain check() fires at most
  // once per launch (the root layout's effect), whatever the
  // outcome. Forced checks (About) neither read nor set this —
  // they are explicit user-surface asks, not the auto-check.
  const autoCheckedRef = useRef(false);

  /**
   * Run the release check. Two call shapes:
   *
   * - check() — the launch auto-check. Fire-once per launch:
   *   after its first run (any outcome), later plain calls are
   *   no-ops, so stray re-renders can never re-hit the network.
   * - check({ force: true }) — About's on-open effect and its
   *   Retry tap. Always starts a FRESH check from any resting
   *   outcome (never checked, checked-current, check-failed):
   *   the reducer's CHECK_STARTED accepts exactly those phases.
   *
   * Both shapes dedupe through checkingRef — a call made while
   * a check is in flight joins it instead of doubling the
   * fetch — and both are ignored while a prompt/flow phase
   * (available…error) is live, so a re-check can never stomp an
   * update the user is acting on.
   */
  const check = useCallback((options?: { force?: boolean }) => {
    if (checkingRef.current) return;
    const phase = stateRef.current.phase;
    if (options?.force) {
      if (
        phase !== 'idle' &&
        phase !== 'current' &&
        phase !== 'checkFailed'
      ) {
        return;
      }
    } else {
      if (autoCheckedRef.current) return;
      if (phase !== 'idle') return;
      autoCheckedRef.current = true;
    }
    checkingRef.current = true;
    setState((s) => updateReducer(s, { type: 'CHECK_STARTED' }));
    void (async () => {
      try {
        const release = await fetchAppVersion();
        if (!release) {
          setState((s) => updateReducer(s, { type: 'CHECK_FAILED' }));
          return;
        }
        const snooze = parseUpdateSnooze(
          await plainStorage.get(UPDATE_SNOOZE_KEY),
        );
        setState((s) =>
          updateReducer(s, {
            type: 'CHECKED',
            release,
            installedVersionCode: installedBuild().versionCode,
            snooze,
            now: Date.now(),
          }),
        );
      } catch {
        setState((s) => updateReducer(s, { type: 'CHECK_FAILED' }));
      } finally {
        checkingRef.current = false;
      }
    })();
  }, []);

  const pressLater = useCallback(() => {
    const current = stateRef.current;
    if (current.phase === 'available') {
      void plainStorage.set(
        UPDATE_SNOOZE_KEY,
        JSON.stringify({
          versionCode: current.release.latestVersionCode,
          until: Date.now() + UPDATE_SNOOZE_MS,
        }),
      );
    }
    setState((s) => updateReducer(s, { type: 'LATER_PRESSED' }));
  }, []);

  const pressUpdate = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'available' && current.phase !== 'required') {
      return;
    }
    const { release } = current;
    setState((s) => updateReducer(s, { type: 'UPDATE_PRESSED' }));
    void (async () => {
      const file = updateApkFile();
      try {
        if (Platform.OS === 'web') {
          throw new Error('Updates install on the Android app.');
        }
        const dir = updateCacheDir();
        if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
        try {
          if (file.exists) file.delete();
        } catch {
          // A stale partial that cannot be removed fails the
          // download below with the real error — surfaced as-is.
        }
        let lastPercent = -1;
        const task = createDownloadResumable(
          release.apkUrl,
          file.uri,
          {},
          (data) => {
            if (data.totalBytesExpectedToWrite <= 0) return;
            const fraction = Math.min(
              1,
              Math.max(
                0,
                data.totalBytesWritten / data.totalBytesExpectedToWrite,
              ),
            );
            const percent = Math.floor(fraction * 100);
            if (percent !== lastPercent) {
              lastPercent = percent;
              setState((s) =>
                updateReducer(s, { type: 'PROGRESS', fraction }),
              );
            }
          },
        );
        const result = await task.downloadAsync();
        if (result === undefined) {
          throw new Error('The download was interrupted.');
        }
        setState((s) => updateReducer(s, { type: 'DOWNLOAD_DONE' }));
        const contentUri = await getContentUriAsync(file.uri);
        await IntentLauncher.startActivityAsync(
          'android.intent.action.VIEW',
          {
            data: contentUri,
            type: 'application/vnd.android.package-archive',
            flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
          },
        );
        // The OS installer has the file now; the cached copy has
        // done its job (the cache dir is OS-reclaimable anyway).
        try {
          if (file.exists) file.delete();
        } catch {
          // Best-effort cleanup only.
        }
      } catch (e) {
        try {
          if (file.exists) file.delete();
        } catch {
          // Best-effort cleanup only.
        }
        setState((s) =>
          updateReducer(s, {
            type: 'FAILED',
            message:
              e instanceof Error
                ? e.message
                : 'The update could not be downloaded.',
          }),
        );
      }
    })();
  }, []);

  const value = useMemo(
    () => ({ state, check, pressUpdate, pressLater }),
    [state, check, pressUpdate, pressLater],
  );
  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdate(): {
  state: UpdateState;
  check: (options?: { force?: boolean }) => void;
  pressUpdate: () => void;
  pressLater: () => void;
} {
  const ctx = useContext(UpdateContext);
  if (!ctx) {
    throw new Error('useUpdate must be used inside UpdateProvider');
  }
  return ctx;
}

function updateCacheDir(): Directory {
  return new Directory(Paths.cache, 'app-update');
}

function updateApkFile(): File {
  return new File(updateCacheDir(), 'kaikansen-update.apk');
}
