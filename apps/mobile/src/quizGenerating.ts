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
 */

/** The three steps, verbatim from the approved design. */
export const GENERATING_STEPS = [
  'Picking your songs',
  'Checking the audio',
  'Lining up your questions',
] as const;

/**
 * Minimum time the generating screen stays up once shown
 * (presentational pacing, approved with the design): a create
 * that resolves near-instantly would otherwise flash the screen
 * for a single frame. The create REQUEST is never delayed —
 * only the application of its result (phase transition) waits
 * out the remainder. 700 ms sits inside the brief's 600–900 ms
 * standard range.
 */
export const GENERATING_MIN_DISPLAY_MS = 700;

/** Elapsed-ms marks at which the ACTIVE step advances. Step 1
 *  completes at 600 ms, step 2 at 2000 ms; step 3 then stays
 *  active until the game actually arrives. */
const STAGE_AT_MS = [600, 2000] as const;

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
