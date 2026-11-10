import type { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { SyncHealthController } from './sync-health.controller';

function controllerWith(configSecret: string | undefined): SyncHealthController {
  const config = {
    get: (key: string) => (key === 'SYNC_SECRET' ? configSecret : undefined),
  } as unknown as ConfigService;
  return new SyncHealthController(config);
}

describe('SyncHealthController (TEMP DIAGNOSTIC)', () => {
  const SECRET = 'diag-test-secret-value';
  const ORIGINAL = process.env.SYNC_SECRET;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.SYNC_SECRET;
    } else {
      process.env.SYNC_SECRET = ORIGINAL;
    }
  });

  it('reports length + sha256 prefix for a known value on both paths, never the value', () => {
    process.env.SYNC_SECRET = SECRET;
    const response = controllerWith(SECRET).syncHealth();
    const expectedPrefix = createHash('sha256')
      .update(SECRET)
      .digest('hex')
      .slice(0, 6);
    const expected: {
      present: boolean;
      length: number;
      sha256Prefix: string;
    } = { present: true, length: SECRET.length, sha256Prefix: expectedPrefix };
    expect(response.status).toBe('ok');
    expect(response.configService).toEqual(expected);
    expect(response.processEnv).toEqual(expected);
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it('fingerprints each read path independently', () => {
    process.env.SYNC_SECRET = 'env-only-value';
    const response = controllerWith(undefined).syncHealth();
    expect(response.configService).toEqual({
      present: false,
      length: null,
      sha256Prefix: null,
    });
    expect(response.processEnv.present).toBe(true);
    expect(response.processEnv.length).toBe('env-only-value'.length);
  });

  it('reports not-present on both paths when the secret is unset', () => {
    delete process.env.SYNC_SECRET;
    const response = controllerWith(undefined).syncHealth();
    const absent = { present: false, length: null, sha256Prefix: null };
    expect(response.configService).toEqual(absent);
    expect(response.processEnv).toEqual(absent);
  });

  it('treats an empty string as not present', () => {
    process.env.SYNC_SECRET = '';
    const response = controllerWith('').syncHealth();
    expect(response.configService.present).toBe(false);
    expect(response.processEnv.present).toBe(false);
  });
});
