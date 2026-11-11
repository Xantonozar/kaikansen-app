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
 *   (any resting outcome ──recheck──┐)
 *   idle ──check──▶ checking ──current/snoozed──▶ current
 *                    │                    │
 *                    ├─available─▶ available ──Later──▶ current (snoozed)
 *                    ├─required──▶ required  (no Later)
 *                    └─failed────▶ checkFailed ──recheck──▶ checking
 *
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
 *
 * CHECK OUTCOMES ARE HONEST (owner ruling 2026-11-11, after the
 * field report that About claimed "up to date" when no check had
 * succeeded): the resting outcome of the last check is part of
 * the state, because a failed check and a completed check are
 * different facts. `current` means a CHECKED event completed
 * with the `current` verdict — including the snoozed-available
 * case, which IS a completed check that produced a verdict.
 * `checkFailed` means the last attempt produced NO verdict.
 * The HOME PROMPT stays silent about failures — the gate never
 * renders either resting phase — but the ABOUT surface reads
 * the outcome and tells the truth: "You're on the latest
 * version." only for `current`, "Couldn't check for updates."
 * (+ Retry) for `checkFailed`. `idle` is the never-checked
 * start and nothing else; a settled check never returns to it.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'checkFailed' }
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
      // A (re)check may start from any resting outcome — never
      // checked, checked-current, or failed — so About can force
      // a fresh check whatever the last attempt did. Live prompt
      // and flow phases (available…error) and an in-flight check
      // are not resting outcomes: CHECK_STARTED is ignored there,
      // so a re-check can never stomp an update in progress.
      return state.phase === 'idle' ||
        state.phase === 'current' ||
        state.phase === 'checkFailed'
        ? { phase: 'checking' }
        : state;
    case 'CHECK_FAILED':
      // A failed check produced no verdict, and the state says
      // so (owner ruling 2026-11-11): `checkFailed`, NOT a
      // silent settle to idle. The HOME PROMPT still never shows
      // a failure — the gate renders nothing for this phase —
      // but About reads it and offers a retry instead of the old
      // lie ("You're on the latest version." on any failure).
      return state.phase === 'checking' ? { phase: 'checkFailed' } : state;
    case 'CHECKED': {
      if (state.phase !== 'checking') return state;
      const verdict = updateVerdict(event.installedVersionCode, event.release);
      if (verdict === 'current') return { phase: 'current' };
      if (
        verdict === 'available' &&
        isSnoozed(
          event.snooze,
          event.release,
          event.installedVersionCode,
          event.now,
        )
      ) {
        // Snoozed is still CHECKED: the check completed and
        // produced a verdict, so the resting outcome is
        // `current` — About may honestly say "latest version"
        // (the snooze suppresses only the prompt).
        return { phase: 'current' };
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
      // required variant has no Later by construction. Snoozing
      // is a completed check with a verdict behind it, so the
      // resting outcome is `current`, same as the CHECKED path.
      return state.phase === 'available' ? { phase: 'current' } : state;
    default:
      return state;
  }
}

/**
 * What About's App update section renders for a machine state —
 * the honesty table (owner ruling 2026-11-11), decided here so
 * the screen itself carries no verdict logic:
 *
 * - available/required/downloading/installing/error → the
 *   shared UpdateCard ('card');
 * - checking, and idle (never checked — About forces a check on
 *   open, so this is at most a first-frame state) → the neutral
 *   "Checking for updates…" line ('checking');
 * - current → "You're on the latest version." ('current') —
 *   reachable ONLY through a completed CHECKED event, never by
 *   default;
 * - checkFailed → "Couldn't check for updates." + Retry
 *   ('failed').
 */
export type AboutUpdateView = 'card' | 'checking' | 'current' | 'failed';

export function aboutUpdateView(state: UpdateState): AboutUpdateView {
  switch (state.phase) {
    case 'available':
    case 'required':
    case 'downloading':
    case 'installing':
    case 'error':
      return 'card';
    case 'current':
      return 'current';
    case 'checkFailed':
      return 'failed';
    case 'idle':
    case 'checking':
      return 'checking';
    default:
      return 'checking';
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
