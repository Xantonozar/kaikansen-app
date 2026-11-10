import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';

function fakeConnection(state: {
  readyState: number;
  ping?: () => Promise<unknown>;
}) {
  return {
    readyState: state.readyState,
    db: { admin: () => ({ ping: state.ping ?? (async () => ({ ok: 1 })) }) },
  } as never;
}

describe('HealthController', () => {
  it('answers 200 not-configured when booted without a database', async () => {
    const controller = new HealthController();
    await expect(controller.health()).resolves.toEqual({
      status: 'ok',
      service: 'kaikansen-api',
      db: 'not-configured',
    });
  });

  it('answers 200 db ok when the connection is up and the ping succeeds', async () => {
    const controller = new HealthController(
      fakeConnection({ readyState: 1 }),
    );
    await expect(controller.health()).resolves.toEqual({
      status: 'ok',
      service: 'kaikansen-api',
      db: 'ok',
    });
  });

  it('answers 503 db down when the connection is not connected', async () => {
    const controller = new HealthController(
      fakeConnection({ readyState: 0 }),
    );
    const error = await controller.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((error as HttpException).getResponse()).toEqual({
      status: 'ok',
      service: 'kaikansen-api',
      db: 'down',
    });
  });

  it('answers 503 db down when ready but the ping rejects', async () => {
    const controller = new HealthController(
      fakeConnection({
        readyState: 1,
        ping: async () => {
          throw new Error('connection closed');
        },
      }),
    );
    const error = await controller.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((error as HttpException).getResponse()).toMatchObject({
      db: 'down',
    });
  });
});
