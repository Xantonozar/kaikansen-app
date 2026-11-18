import { Injectable } from '@nestjs/common';

/**
 * In-memory chat presence: which userIds currently hold at least
 * one socket on the gateway, and when each user was last seen
 * (their final socket's disconnect). Deliberately coarse and
 * truthful — `online` means "a socket is connected right now";
 * anything else is reported as a last-active timestamp, never as
 * fake presence. State is per-process, like the quiz room
 * heartbeat's authority model; a restart simply resets it.
 */
/** Last-active entries older than this are evicted (lazy sweep on writes). */
const LAST_ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on tracked last-active entries, oldest evicted first. */
const LAST_ACTIVE_MAX_ENTRIES = 10000;

@Injectable()
export class ChatPresence {
  private readonly socketsByUser = new Map<string, Set<string>>();
  private readonly lastActiveByUser = new Map<string, number>();

  /**
   * Keeps lastActiveByUser bounded on a long-lived process:
   * drops entries older than the TTL, then trims to the cap
   * (Map iteration is insertion-ordered, so the front is the
   * oldest). Runs on writes only — no timer, no sweeper.
   */
  private sweepLastActive(): void {
    const cutoff = Date.now() - LAST_ACTIVE_TTL_MS;
    for (const [userId, at] of this.lastActiveByUser) {
      if (at < cutoff) this.lastActiveByUser.delete(userId);
    }
    while (this.lastActiveByUser.size > LAST_ACTIVE_MAX_ENTRIES) {
      const oldest = this.lastActiveByUser.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.lastActiveByUser.delete(oldest);
    }
  }

  /** Registers a socket. Returns true when the user CAME online (first socket). */
  add(userId: string, socketId: string): boolean {
    this.sweepLastActive();
    let set = this.socketsByUser.get(userId);
    const wasOnline = !!set && set.size > 0;
    if (!set) {
      set = new Set<string>();
      this.socketsByUser.set(userId, set);
    }
    set.add(socketId);
    return !wasOnline;
  }

  /** Removes a socket. Returns true when the user WENT offline (last socket). */
  remove(userId: string, socketId: string): boolean {
    const set = this.socketsByUser.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size > 0) return false;
    this.socketsByUser.delete(userId);
    this.lastActiveByUser.set(userId, Date.now());
    this.sweepLastActive();
    return true;
  }

  isOnline(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  /** ISO timestamp of the last disconnect, or null when never seen / currently online. */
  lastActiveAt(userId: string): string | null {
    if (this.isOnline(userId)) return null;
    const at = this.lastActiveByUser.get(userId);
    return at ? new Date(at).toISOString() : null;
  }
}
