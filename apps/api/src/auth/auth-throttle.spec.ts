import { authAccountTracker } from './auth-throttle';

/**
 * The per-account throttler tracker: keyed by the targeted email
 * (trimmed + lowercased, matching how accounts are stored), with
 * an IP fallback when the body carries no usable email.
 */
describe('authAccountTracker', () => {
  it('keys by the lowercased, trimmed body email', () => {
    expect(
      authAccountTracker({
        ip: '203.0.113.7',
        body: { email: '  Victim@Example.COM ' },
      }),
    ).toBe('email:victim@example.com');
  });

  it('falls back to the IP when no email is present', () => {
    expect(authAccountTracker({ ip: '203.0.113.7', body: {} })).toBe(
      'ip:203.0.113.7',
    );
    expect(authAccountTracker({ ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
  });

  it('falls back to the IP for a non-string or blank email', () => {
    expect(
      authAccountTracker({ ip: '203.0.113.7', body: { email: 42 } }),
    ).toBe('ip:203.0.113.7');
    expect(
      authAccountTracker({ ip: '203.0.113.7', body: { email: '   ' } }),
    ).toBe('ip:203.0.113.7');
  });
});
