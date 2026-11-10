/**
 * Count-up interpolation (extracted from the Library tab's
 * useCountUp hook for the mobile test foundation, audit S6).
 *
 * The displayed value at progress `t` (0..1, clamped) of an
 * animation from `from` to `target`: an ease-out cubic — big
 * early steps, settling gently — rounded to the nearest integer.
 * At t = 0 the value is exactly `from`; at t = 1 exactly
 * `target`; it never overshoots in either direction.
 */
export function countUpValue(from: number, target: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const eased = 1 - Math.pow(1 - clamped, 3);
  return Math.round(from + (target - from) * eased);
}
