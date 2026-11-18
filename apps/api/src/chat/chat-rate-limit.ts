/**
 * Small in-memory helpers for the chat gateway (no Nest, no I/O —
 * unit-tested directly):
 *
 * - ChatRateLimiter: a sliding-window allow/deny counter. The
 *   REST surface is throttled by @nestjs/throttler (see
 *   chat-throttle.ts), but socket events never pass a guard, so
 *   the gateway enforces its own send/typing limits with this.
 * - PartnerIdsCache: presence fan-out needs the user's
 *   conversation partners on every connect/disconnect; the set
 *   changes rarely, so it is cached briefly instead of hitting
 *   the DB on every flap (reconnect storms included).
 */

export class ChatRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt for `key`; returns false when the window is already full. */
  allow(key: string, now: number = Date.now()): boolean {
    const fresh = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}

export class PartnerIdsCache {
  private readonly entries = new Map<
    string,
    { at: number; ids: string[] }
  >();

  constructor(private readonly ttlMs: number = 30_000) {}

  get(userId: string, now: number = Date.now()): string[] | null {
    const entry = this.entries.get(userId);
    if (!entry || now - entry.at > this.ttlMs) return null;
    return entry.ids;
  }

  set(userId: string, ids: string[], now: number = Date.now()): void {
    this.entries.set(userId, { at: now, ids });
  }

  invalidate(userId: string): void {
    this.entries.delete(userId);
  }

  clear(): void {
    this.entries.clear();
  }
}
