import type { ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate limiting for the chat REST surface (deep analysis §3:
 * the chat controller previously had NO throttling at all — one
 * account could spray request opens and sends at wire speed).
 * Mirrors the auth-throttle.ts pattern: one named bucket,
 * enforced by ThrottlerGuard on the chat controller ONLY, with
 * per-route @Throttle overrides.
 *
 * The bucket is keyed by the AUTHENTICATED user id (the guard
 * chain runs AccessTokenGuard first, so req.user exists when the
 * tracker reads it), falling back to the client IP for any
 * unauthenticated reach. Per-account keying is the point: chat
 * abuse is an account behaviour, and IP keying alone would let
 * one user behind a shared NAT be throttled by another.
 *
 * Limits (deep-analysis fix pass, 2026-11-18):
 * - baseline:          600/min per user (generous; reads included)
 * - POST conversations (opens):  30/hour per user
 * - POST messages (REST sends):  60/min per user (the socket path
 *   is limited separately in the gateway — same numbers)
 * - GET people/search:           30/min per user
 *
 * Socket send/typing limits live in chat.gateway.ts (guards do
 * not run for socket events). Service-level caps that must hold
 * on BOTH transports (3-message pending-request cap, daily
 * first-contact limit) live in ChatService itself.
 */

type TrackerRequest = {
  ip?: string;
  user?: { userId?: string };
};

/** The `chat-user` bucket's tracker: the signed-in user id, else the IP. */
export function chatUserTracker(req: Record<string, unknown>): string {
  const request = req as TrackerRequest;
  if (typeof request.user?.userId === 'string' && request.user.userId) {
    return `user:${request.user.userId}`;
  }
  return `ip:${request.ip ?? 'unknown'}`;
}

/** ThrottlerModule options for ChatModule (see the header above). */
export const CHAT_THROTTLER_OPTIONS: ThrottlerOptions[] = [
  {
    name: 'chat-user',
    ttl: 60_000,
    limit: 600,
    getTracker: (req: Record<string, unknown>) => chatUserTracker(req),
  },
];

/** Per-route @Throttle overrides, named so the controller reads cleanly. */
export const CHAT_THROTTLE = {
  open: {
    'chat-user': { limit: 30, ttl: 3_600_000 },
  },
  send: {
    'chat-user': { limit: 60, ttl: 60_000 },
  },
  search: {
    'chat-user': { limit: 30, ttl: 60_000 },
  },
} as const;
