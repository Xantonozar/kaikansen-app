import type { ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate limiting for the auth surface (audit 2026-11-10, item C1 —
 * the API previously had NO throttling anywhere: login was open to
 * credential stuffing and forgot-password issuance could be used
 * to email-bomb any address through the owner's Brevo account).
 *
 * Two named buckets, both enforced by ThrottlerGuard on the auth
 * controller ONLY (AuthModule imports the module; no other
 * controller carries the guard, so the rest of the API is
 * untouched):
 *
 * - `auth-ip` — keyed by client IP. Loose baseline for the whole
 *   controller; tightened per route below via @Throttle.
 * - `auth-account` — keyed by the email in the request body (the
 *   account being targeted), falling back to the IP when a body
 *   carries no usable email. This is the per-account backstop:
 *   distributed guessing against ONE account stays capped even
 *   when the attacker rotates IPs. Routes whose bodies carry no
 *   email skip this bucket (@SkipThrottle).
 *
 * Limits (chosen 2026-11-10; the e2e suites that boot the real
 * AppModule make only a handful of auth calls per app instance,
 * so these never bite tests — the throttling behaviour itself is
 * proven by test/auth-throttle.e2e-spec.ts against a model-less
 * AuthModule, where handlers answer 503 until the bucket trips
 * and 429 after):
 * - login:            20/min per IP · 10/15min per email
 * - register:         10/hour per IP · 5/hour per email
 * - forgot-password:  10/hour per IP · 5/hour per email (strictest
 *   — every issuance can cost a real email send)
 * - reset-password:   20/hour per IP · 10/hour per email (the code
 *   itself already burns after 5 failed verifications; this is
 *   the outer backstop)
 * - refresh:          60/min per IP (rotation is chatty by design;
 *   the reuse detection in AuthService is the real defence there)
 */

type TrackerRequest = {
  ip?: string;
  body?: Record<string, unknown>;
};

function ipOf(req: TrackerRequest): string {
  return req.ip ?? 'unknown';
}

/** The `auth-account` bucket's tracker: the targeted email, else the IP. */
export function authAccountTracker(req: Record<string, unknown>): string {
  const request = req as TrackerRequest;
  const email = request.body?.email;
  if (typeof email === 'string' && email.trim().length > 0) {
    return `email:${email.trim().toLowerCase()}`;
  }
  return `ip:${ipOf(request)}`;
}

/** ThrottlerModule options for AuthModule (see the header above). */
export const AUTH_THROTTLER_OPTIONS: ThrottlerOptions[] = [
  {
    name: 'auth-ip',
    ttl: 60_000,
    limit: 300,
  },
  {
    name: 'auth-account',
    ttl: 3_600_000,
    limit: 1_000,
    getTracker: (req: Record<string, unknown>) => authAccountTracker(req),
  },
];

/** Per-route @Throttle overrides, named so the controller reads cleanly. */
export const AUTH_THROTTLE = {
  login: {
    'auth-ip': { limit: 20, ttl: 60_000 },
    'auth-account': { limit: 10, ttl: 900_000 },
  },
  register: {
    'auth-ip': { limit: 10, ttl: 3_600_000 },
    'auth-account': { limit: 5, ttl: 3_600_000 },
  },
  forgotPassword: {
    'auth-ip': { limit: 10, ttl: 3_600_000 },
    'auth-account': { limit: 5, ttl: 3_600_000 },
  },
  resetPassword: {
    'auth-ip': { limit: 20, ttl: 3_600_000 },
    'auth-account': { limit: 10, ttl: 3_600_000 },
  },
  refresh: {
    'auth-ip': { limit: 60, ttl: 60_000 },
  },
} as const;

/** @SkipThrottle argument for routes with no email in the body. */
export const SKIP_ACCOUNT_THROTTLE = { 'auth-account': true } as const;
