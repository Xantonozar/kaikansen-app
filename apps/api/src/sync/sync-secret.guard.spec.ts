import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SyncSecretGuard } from './sync-secret.guard';

function contextWith(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(secret: string | undefined): SyncSecretGuard {
  const config = {
    get: (key: string) => (key === 'SYNC_SECRET' ? secret : undefined),
  } as unknown as ConfigService;
  return new SyncSecretGuard(config);
}

describe('SyncSecretGuard', () => {
  const SECRET = 'test-sync-secret';

  it('throws 503 when SYNC_SECRET is not configured (fails closed)', () => {
    const guard = guardWith(undefined);
    expect(() =>
      guard.canActivate(contextWith({ 'x-sync-secret': SECRET })),
    ).toThrow(ServiceUnavailableException);
  });

  it('throws 401 when the header is missing', () => {
    const guard = guardWith(SECRET);
    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when the secret is wrong (same length and different length)', () => {
    const guard = guardWith(SECRET);
    expect(() =>
      guard.canActivate(contextWith({ 'x-sync-secret': 'test-sync-secreX' })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(contextWith({ 'x-sync-secret': 'short' })),
    ).toThrow(UnauthorizedException);
  });

  it('passes with the correct secret', () => {
    const guard = guardWith(SECRET);
    expect(
      guard.canActivate(contextWith({ 'x-sync-secret': SECRET })),
    ).toBe(true);
  });
});
