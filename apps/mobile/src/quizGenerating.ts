/**
 * Solo quiz generating screen — the PURE cadence core of the
 * "Setting up your quiz" waiting screen (approved Stitch design
 * cfc7c9ac, ozar "Keep" 2026-11-11; the component is
 * src/components/QuizGenerating.tsx).
 *
 * The client cannot observe the server's internal dealing steps
 * (pool draw, part-7 audio verification, question lining-up), so
 * the step cadence here is PRESENTATIONAL: steps advance on a
 * gentle fixed schedule while the create call is in flight, and
 * the LAST step never reports done from the cadence — the screen
 * exits through the real phase transition when the game arrives,
 * so no displayed completion can contradict reality. Likewise
 * the progress value creeps toward a cap and never reaches 1:
 * the bar is honest about still waiting.
 *
 * Setup window (clock batch, 2026-11-12 — diagnosis §6): the
 * screen is no longer just pacing a flash. Question 1 used to
 * be categorically excluded from every preload: its audio load
 * began only after this screen exited and the question mounted,
 * so Q1 paid a full cold load (create round trip, then media)
 * inside its own clock wait while later questions rode their
 * prefetched slices. Now Q1's player is PRE-MOUNTED behind
 * this screen the moment the create response lands, streaming
 * its remote chain, and the screen's minimum display is a
 * deliberate 4.5 s that gives that stream a head start. The
 * exit itself is gated by setupWindowShouldExit below: the
 * minimum elapsed AND Q1's media decided (genuinely playing,
 * or the failed/empty verdict) — with a 10 s bound from the
 * media mount so a never-deciding load still hands over to
 * the question's own machinery instead of holding the screen.
 * The remote chain, not the slice file: at the owner's
 * measured ~87 KB/s worst-case flow a 1 MB slice needs ~11.5 s
 * to finalize — outside any honest window — while the same
 * bytes as a stream are ~9–18 s of buffered audio by exit.
 */

/** The three steps, verbatim from the approved design. */
export const GENERATING_STEPS = [
  'Picking your songs',
  'Checking the audio',
  'Lining up your questions',
] as const;

/**
 * Minimum time the generating screen stays up once shown. As
 * of the setup window (2026-11-12) this is a DELIBERATE 4.5 s:
 * the window exists so question 1's pre-mounted player can
 * stream a head start behind the screen (see the module
 * docblock) — the exit gate (setupWindowShouldExit) requires
 * this minimum AND Q1's media decision. (Before the setup
 * window it was 700 ms of pure anti-flash pacing.)
 */
export const GENERATING_MIN_DISPLAY_MS = 4500;

/**
 * The floor for a FAILED create only: a fatal error still
 * waits out a short beat so the screen never flashes straight
 * into the error state. (The pre-setup-window minimum; the
 * success path is governed by the setup window instead.)
 */
export const GENERATING_ERROR_MIN_DISPLAY_MS = 700;

/** Elapsed-ms marks at which the ACTIVE step advances, spaced
 *  across the 4.5 s setup window: step 1 completes at 1500 ms,
 *  step 2 at 3000 ms; step 3 then stays active until the game
 *  actually arrives. */
const STAGE_AT_MS = [1500, 3000] as const;

/**
 * The setup window's outer bound, in ms from the moment Q1's
 * player mounted behind the screen: if the media still has not
 * decided (neither genuinely playing nor a verdict) by then,
 * the screen hands over to the question anyway and the
 * question's own stall/verdict machinery finishes the job —
 * the window may never become a second hang.
 */
export const SETUP_MEDIA_BOUND_MS = 10_000;

/**
 * May the setup window exit into question 1? ALL of:
 * - the create result has been applied (Q1 exists and its
 *   player is mounted behind the screen);
 * - the deliberate minimum has elapsed;
 * - EITHER Q1's media has decided (genuinely playing, or the
 *   failed/empty verdict — the question is live either way,
 *   and the clock doctrine starts Q1's clock from that same
 *   signal the moment the question phase begins),
 *   OR the media-mount bound has elapsed (honest hold: the
 *   screen waited as long as it may; the in-question machinery
 *   takes over).
 */
export function setupWindowShouldExit(input: {
  createApplied: boolean;
  elapsedMs: number;
  mediaDecided: boolean;
  mediaMountedMs: number;
}): boolean {
  if (!input.createApplied) return false;
  if (input.elapsedMs < GENERATING_MIN_DISPLAY_MS) return false;
  if (input.mediaDecided) return true;
  return input.mediaMountedMs >= SETUP_MEDIA_BOUND_MS;
}

/**
 * Which step is active after `elapsedMs` on the generating
 * screen: steps before the returned index read done, the
 * returned step reads active, later steps read waiting. Never
 * returns an index past the last step — the last step's
 * completion is the phase transition itself, not the cadence.
 */
export function generatingStageAt(elapsedMs: number): 0 | 1 | 2 {
  if (elapsedMs >= STAGE_AT_MS[1]) return 2;
  if (elapsedMs >= STAGE_AT_MS[0]) return 1;
  return 0;
}

/** The progress bar never claims more than this fraction. */
export const GENERATING_PROGRESS_CAP = 0.9;

/** Time constant of the progress creep: ~60% at 2 s (the
 *  design's resting fill), slowing as it approaches the cap. */
const PROGRESS_TAU_MS = 1800;

/**
 * Displayed progress fraction after `elapsedMs`: an exponential
 * approach to GENERATING_PROGRESS_CAP — brisk at first (the
 * design rests near 60%), then an ever-slower creep. It never
 * passes the cap and never reads full while the wait continues
 * (after minutes the float saturates at exactly the cap, which
 * is the same statement on screen: 90%, still waiting).
 */
export function generatingProgressAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return GENERATING_PROGRESS_CAP * (1 - Math.exp(-elapsedMs / PROGRESS_TAU_MS));
}
