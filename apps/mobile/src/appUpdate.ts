import type { AppVersionResponse } from '@kaikansen/contracts';

/**
 * In-app update logic (release readiness, 2026-11-11) — the PURE
 * half of the update feature: comparison, snooze and the prompt
 * state machine. The impure halves live in appUpdateRuntime.ts
 * (fetch, storage, download, installer) and present through
 * UpdatePromptGate/About; everything decidable lives here and
 * unit-tests directly (appUpdate.test.ts), the repo convention.
 *
 * Platform truth the machine honours: a sideloaded app cannot
 * install silently — Update downloads the APK in-app with real
 * progress, then Android's own installer opens and the user
 * confirms once. Same signing key ⇒ installs over, data survives.
 */

/** How long "Later" silences an optional prompt: 24 hours. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** AsyncStorage key for the snooze record (kaikansen.* convention). */
export const UPDATE_SNOOZE_KEY = 'kaikansen.updateSnooze.v1';

export type UpdateVerdict =
  /** Installed build is current (or ahead) — nothing to offer. */
  | 'current'
  /** A newer build exists and the installed one may keep running. */
  | 'available'
  /** Installed build is below the supported floor — must update. */
  | 'required';

/**
 * Compare the installed build against the served release facts.
 * versionCode is the only honest comparison axis (marketing
 * version strings do not order). The required floor is checked
 * first: below `minSupportedVersionCode` the update is not
 * optional, whatever else is true.
 */
export function updateVerdict(
  installedVersionCode: number,
  release: Pick<
    AppVersionResponse,
    'latestVersionCode' | 'minSupportedVersionCode'
  >,
): UpdateVerdict {
  if (installedVersionCode < release.minSupportedVersionCode) {
    return 'required';
  }
  if (installedVersionCode < release.latestVersionCode) {
    return 'available';
  }
  return 'current';
}

/** What "Later" persists: which release was snoozed, and until when. */
export interface UpdateSnooze {
  /** The latestVersionCode the user snoozed. */
  versionCode: number;
  /** Epoch ms at which the snooze expires. */
  until: number;
}

/**
 * Parse a stored snooze record. Anything malformed (older shapes,
 * hand-edited storage) resolves to null = no snooze — a corrupt
 * record must never suppress a prompt forever.
 */
export function parseUpdateSnooze(
  raw: string | null | undefined,
): UpdateSnooze | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateSnooze>;
    if (
      typeof parsed.versionCode === 'number' &&
      typeof parsed.until === 'number' &&
      Number.isFinite(parsed.versionCode) &&
      Number.isFinite(parsed.until)
    ) {
      return { versionCode: parsed.versionCode, until: parsed.until };
    }
  } catch {
    // Falls through to null.
  }
  return null;
}

/**
 * Whether a snooze silences the prompt for this release right now.
 * Two escape hatches, both deliberate:
 * - a NEWER release than the snoozed one re-prompts immediately
 *   (the snooze names a versionCode, not "updates in general");
 * - a REQUIRED update is never snoozed.
 */
export function isSnoozed(
  snooze: UpdateSnooze | null,
  release: Pick<
    AppVersionResponse,
    'latestVersionCode' | 'minSupportedVersionCode'
  >,
  installedVersionCode: number,
  now: number,
): boolean {
  if (!snooze) return false;
  if (now >= snooze.until) return false;
  if (release.latestVersionCode > snooze.versionCode) return false;
  if (updateVerdict(installedVersionCode, release) === 'required') {
    return false;
  }
  return true;
}

/**
 * The prompt's state machine:
 *
 *   idle ──check──▶ checking ──current/snoozed──▶ idle
 *                    │
 *                    ├─available─▶ available ──Later──▶ idle (snoozed)
 *                    ├─required──▶ required  (no Later)
 *                    │
 *   available/required ──Update──▶ downloading(progress 0..1)
 *                    │                  │ download fails
 *                    │                  ▼
 *                    └─────────────── error (message + browser fallback)
 *                                       downloading completes
 *                                              ▼
 *                                     installing (installer opening;
 *                                     failure lands in the same error
 *                                     state, success leaves the app —
 *                                     the OS takes over)
 *
 * `progress` is the resumable download's REAL fraction
 * (totalBytesWritten / totalBytesExpectedToWrite) — the card
 * never draws a fill the bytes do not back.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; release: AppVersionResponse }
  | { phase: 'required'; release: AppVersionResponse }
  | { phase: 'downloading'; release: AppVersionResponse; progress: number }
  | { phase: 'installing'; release: AppVersionResponse }
  | { phase: 'error'; release: AppVersionResponse; message: string };

export type UpdateEvent =
  | { type: 'CHECK_STARTED' }
  | {
      type: 'CHECKED';
      release: AppVersionResponse;
      installedVersionCode: number;
      snooze: UpdateSnooze | null;
      now: number;
    }
  | { type: 'CHECK_FAILED' }
  | { type: 'UPDATE_PRESSED' }
  | { type: 'PROGRESS'; fraction: number }
  | { type: 'DOWNLOAD_DONE' }
  | { type: 'FAILED'; message: string }
  | { type: 'LATER_PRESSED' };

/**
 * Pure transition function. Events that do not apply to the
 * current phase are ignored (the same state comes back) — the
 * runtime can fire optimistically without corrupting the machine.
 */
export function updateReducer(
  state: UpdateState,
  event: UpdateEvent,
): UpdateState {
  switch (event.type) {
    case 'CHECK_STARTED':
      return state.phase === 'idle' ? { phase: 'checking' } : state;
    case 'CHECK_FAILED':
      // A failed check is a silent no-op by spec — back to idle,
      // the user is never told the check itself failed.
      return state.phase === 'checking' ? { phase: 'idle' } : state;
    case 'CHECKED': {
      if (state.phase !== 'checking') return state;
      const verdict = updateVerdict(event.installedVersionCode, event.release);
      if (verdict === 'current') return { phase: 'idle' };
      if (
        verdict === 'available' &&
        isSnoozed(
          event.snooze,
          event.release,
          event.installedVersionCode,
          event.now,
        )
      ) {
        return { phase: 'idle' };
      }
      return verdict === 'required'
        ? { phase: 'required', release: event.release }
        : { phase: 'available', release: event.release };
    }
    case 'UPDATE_PRESSED':
      return state.phase === 'available' || state.phase === 'required'
        ? { phase: 'downloading', release: state.release, progress: 0 }
        : state;
    case 'PROGRESS':
      return state.phase === 'downloading'
        ? {
            phase: 'downloading',
            release: state.release,
            progress: Math.min(1, Math.max(0, event.fraction)),
          }
        : state;
    case 'DOWNLOAD_DONE':
      return state.phase === 'downloading'
        ? { phase: 'installing', release: state.release }
        : state;
    case 'FAILED':
      return state.phase === 'downloading' || state.phase === 'installing'
        ? { phase: 'error', release: state.release, message: event.message }
        : state;
    case 'LATER_PRESSED':
      // Only the optional prompt can be snoozed away; the
      // required variant has no Later by construction.
      return state.phase === 'available' ? { phase: 'idle' } : state;
    default:
      return state;
  }
}

/**
 * Render priority: the offline takeover outranks the update
 * prompt (release readiness spec §3). While the gate's takeover
 * is showing, the prompt waits — its state is untouched, so it
 * simply appears when the takeover clears.
 */
export function shouldShowUpdatePrompt(offlineTakeoverShowing: boolean): boolean {
  return !offlineTakeoverShowing;
}
