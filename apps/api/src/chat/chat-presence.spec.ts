import { ChatPresence } from './chat-presence';

/**
 * ChatPresence unit tests — the last-active map must stay
 * bounded on a long-lived process: entries older than 30 days
 * are evicted lazily on writes, and the map is hard-capped.
 */
describe('ChatPresence — last-active eviction', () => {
  it('evicts last-active entries older than 30 days on the next write', () => {
    const presence = new ChatPresence();
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      presence.add('user-old', 's1');
      presence.remove('user-old', 's1');
      expect(presence.lastActiveAt('user-old')).not.toBeNull();

      // 31 days later, another user's disconnect sweeps stale rows.
      nowSpy.mockReturnValue(t0 + 31 * 24 * 3600 * 1000);
      presence.add('user-new', 's2');
      presence.remove('user-new', 's2');
      expect(presence.lastActiveAt('user-old')).toBeNull();
      expect(presence.lastActiveAt('user-new')).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps fresh entries and online state intact across sweeps', () => {
    const presence = new ChatPresence();
    presence.add('user-a', 's1');
    expect(presence.isOnline('user-a')).toBe(true);
    expect(presence.lastActiveAt('user-a')).toBeNull(); // online → no last-active
    presence.remove('user-a', 's1');
    expect(presence.isOnline('user-a')).toBe(false);
    expect(presence.lastActiveAt('user-a')).not.toBeNull();
  });
});
