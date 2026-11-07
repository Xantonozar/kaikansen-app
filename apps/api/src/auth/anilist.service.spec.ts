import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { AnilistClient, AnilistViewer } from './anilist.client';
import { AuthService, OAUTH_PASSWORD_SENTINEL } from './auth.service';

/**
 * AniList OAuth unit tests. The AniList client and the user model are
 * fakes — no live network, no real AniList credentials; JWTs run for
 * real against obviously-fake test secrets, as in auth.service.spec.
 */

const ACCESS_SECRET = 'unit-test-access-secret';
const REFRESH_SECRET = 'unit-test-refresh-secret';

const ANILIST_ENV: Record<string, string> = {
  ANILIST_CLIENT_ID: 'test-client-id',
  ANILIST_CLIENT_SECRET: 'test-client-secret',
  ANILIST_REDIRECT_URI: 'https://example.com/oauth/callback',
  ANILIST_POST_LOGIN_REDIRECT: 'https://preview.example/auth/complete',
};

function configStub(extra: Record<string, string> = {}) {
  const values: Record<string, string> = {
    JWT_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    ...extra,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const VIEWER: AnilistViewer = {
  id: 42,
  name: 'Test User!',
  avatar: { large: 'https://img.example/avatar-large.png' },
};

function makeClient(overrides: Partial<AnilistClient> = {}) {
  return {
    exchangeCode: jest.fn(async () => ({
      accessToken: 'anilist-access-token-1',
    })),
    fetchViewer: jest.fn(async () => VIEWER),
    ...overrides,
  } as unknown as AnilistClient;
}

interface FakeAnilist {
  accessToken?: string;
  userId?: number;
  username?: string;
  syncedAt?: Date;
}

interface FakeUser extends Record<string, unknown> {
  _id: string;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string;
  avatarUrl: string | null;
  anilist?: FakeAnilist;
  save: jest.Mock;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

function makeModel() {
  const users: FakeUser[] = [];
  let seq = 0;
  const model = {
    users,
    findOne: jest.fn((filter: Record<string, unknown>) => {
      let found: FakeUser | null = null;
      if (filter.$or) {
        const clauses = filter.$or as Record<string, string>[];
        found =
          users.find((u) =>
            clauses.some(
              (c) => u.email === c.email || u.username === c.username,
            ),
          ) ?? null;
      } else if (filter['anilist.userId'] !== undefined) {
        found =
          users.find((u) => u.anilist?.userId === filter['anilist.userId']) ??
          null;
      } else if (filter.username) {
        found = users.find((u) => u.username === filter.username) ?? null;
      } else if (filter.email) {
        found = users.find((u) => u.email === filter.email) ?? null;
      }
      return queryOf(found);
    }),
    findById: jest.fn((id: string) =>
      queryOf(users.find((u) => u._id === id) ?? null),
    ),
    findByIdAndUpdate: jest.fn(
      (
        id: string,
        update: { $set: Record<string, unknown> },
      ) => {
        const doc = users.find((u) => u._id === id) ?? null;
        if (doc && update.$set) {
          Object.assign(doc, update.$set);
        }
        return queryOf(doc);
      },
    ),
    create: jest.fn(async (data: Partial<FakeUser>) => {
      const doc = {
        _id: `fake-user-${++seq}`,
        avatarUrl: null,
        ...(data as FakeUser),
        save: jest.fn(async () => doc),
      } as FakeUser;
      users.push(doc);
      return doc;
    }),
    /** Seed a user directly (as if created earlier / by the web). */
    seed(data: Partial<FakeUser>): FakeUser {
      const doc = {
        _id: `fake-user-${++seq}`,
        avatarUrl: null,
        ...(data as FakeUser),
        save: jest.fn(async () => doc),
      } as FakeUser;
      users.push(doc);
      return doc;
    },
  };
  return model;
}

function makeService(opts: {
  model?: ReturnType<typeof makeModel> | null;
  client?: AnilistClient | null;
  env?: Record<string, string>;
} = {}) {
  const model = opts.model === undefined ? makeModel() : opts.model;
  const client = opts.client === undefined ? makeClient() : opts.client;
  const env = opts.env === undefined ? ANILIST_ENV : opts.env;
  const service = new AuthService(
    model as never,
    configStub(env),
    client as AnilistClient,
  );
  return { service, model: model as ReturnType<typeof makeModel>, client };
}

describe('AniList URL', () => {
  it('builds the authorize URL from env, like the web', async () => {
    const { service } = makeService();
    const { url } = await service.anilistUrl();
    const expected = new URLSearchParams({
      client_id: 'test-client-id',
      redirect_uri: 'https://example.com/oauth/callback',
      response_type: 'code',
    });
    expect(url).toBe(
      `https://anilist.co/api/v2/oauth/authorize?${expected.toString()}`,
    );
  });

  it('answers 503 when any AniList env var is unset', async () => {
    const { service } = makeService({
      env: { ANILIST_CLIENT_ID: 'test-client-id' },
    });
    await expect(service.anilistUrl()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 503 without a database', async () => {
    const { service } = makeService({ model: null });
    await expect(service.anilistUrl()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('forwards a caller state into the authorize URL', async () => {
    const { service } = makeService();
    const link = await service.anilistUrl('link');
    expect(link.url).toContain('&state=link');
    const login = await service.anilistUrl('login');
    expect(login.url).toContain('&state=login');
    const plain = await service.anilistUrl();
    expect(plain.url).not.toContain('state=');
  });
});

describe('AniList callback (login / register)', () => {
  it('creates a new user: synthetic email, sentinel hash, token stored, JWT pair out', async () => {
    const { service, model, client } = makeService();
    const res = await service.anilistCallback({ code: 'auth-code-1' });

    expect(client.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'test-client-id' }),
      'auth-code-1',
    );
    expect(model.create).toHaveBeenCalledTimes(1);
    const created = model.users[0];
    expect(created.username).toBe('testuser'); // 'Test User!' mangled like the web
    expect(created.displayName).toBe('Test User!');
    expect(created.email).toBe('anilist_42@kaikansen.io');
    expect(created.passwordHash).toBe(OAUTH_PASSWORD_SENTINEL);
    expect(created.avatarUrl).toBe('https://img.example/avatar-large.png');
    expect(created.anilist).toMatchObject({
      accessToken: 'anilist-access-token-1',
      userId: 42,
      username: 'Test User!',
    });
    expect(created.anilist?.syncedAt).toBeInstanceOf(Date);

    expect(res.user).toMatchObject({
      id: created._id,
      username: 'testuser',
      email: 'anilist_42@kaikansen.io',
    });
    const access = jwt.verify(res.accessToken, ACCESS_SECRET) as {
      tokenType: string;
    };
    const refresh = jwt.verify(res.refreshToken, REFRESH_SECRET) as {
      tokenType: string;
    };
    expect(access.tokenType).toBe('access');
    expect(refresh.tokenType).toBe('refresh');
    expect(JSON.stringify(res)).not.toContain('anilist-access-token-1');
  });

  it('appends the AniList id when the derived username is taken', async () => {
    const { service, model } = makeService();
    model.seed({
      username: 'testuser',
      displayName: 'Someone Else',
      email: 'someone@example.com',
      passwordHash: 'hashed',
    });
    const res = await service.anilistCallback({ code: 'auth-code-1' });
    expect(res.user.username).toBe('testuser42');
  });

  it('logs in an existing AniList user — no duplicate, token refreshed', async () => {
    const { service, model } = makeService();
    const existing = model.seed({
      username: 'testuser',
      displayName: 'Test User!',
      email: 'anilist_42@kaikansen.io',
      passwordHash: OAUTH_PASSWORD_SENTINEL,
      anilist: {
        accessToken: 'anilist-access-token-OLD',
        userId: 42,
        username: 'Test User!',
        syncedAt: new Date(0),
      },
    });
    const res = await service.anilistCallback({ code: 'auth-code-2' });
    expect(model.create).not.toHaveBeenCalled();
    expect(model.users).toHaveLength(1);
    expect(res.user.id).toBe(existing._id);
    expect(existing.anilist?.accessToken).toBe('anilist-access-token-1');
    expect(existing.anilist?.syncedAt?.getTime()).toBeGreaterThan(0);
    expect(existing.save).toHaveBeenCalled();
  });

  it('maps invalid_client to the web’s rejected-credentials message (502)', async () => {
    const { service } = makeService({
      client: makeClient({
        exchangeCode: jest.fn(async () => ({ error: 'invalid_client' })),
      }),
    });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('AniList rejected your Client ID/Secret'),
      }),
    });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('passes through AniList’s own failure message (502)', async () => {
    const { service } = makeService({
      client: makeClient({
        exchangeCode: jest.fn(async () => ({
          error: 'invalid_grant',
          message: 'The authorization code is invalid',
        })),
      }),
    });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'The authorization code is invalid',
      }),
    });
  });

  it('answers 502 when the viewer fetch finds no viewer', async () => {
    const { service } = makeService({
      client: makeClient({ fetchViewer: jest.fn(async () => null) }),
    });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Failed to fetch AniList profile',
      }),
    });
  });

  it('answers 500 (web catch-all) when the AniList call itself blows up', async () => {
    const { service } = makeService({
      client: makeClient({
        exchangeCode: jest.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Internal server error' }),
    });
  });

  it('rejects a missing code with the web’s failure message (400)', async () => {
    const { service } = makeService();
    await expect(
      service.anilistCallback({ code: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 503 when AniList env is unset', async () => {
    const { service } = makeService({ env: {} });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 503 when the client is not wired (model-less boot shape)', async () => {
    const { service } = makeService({ client: null });
    await expect(service.anilistCallback({ code: 'x' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AniList link', () => {  it('links the AniList account to the caller ($set, like the web)', async () => {
    const { service, model } = makeService();
    const caller = model.seed({
      username: 'caller',
      displayName: 'Caller',
      email: 'caller@example.com',
      passwordHash: 'hashed',
    });
    const res = await service.anilistLink(caller._id, { code: 'auth-code-1' });
    expect(res).toEqual({
      linked: true,
      anilist: { userId: 42, username: 'Test User!' },
    });
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      caller._id,
      {
        $set: {
          anilist: expect.objectContaining({
            accessToken: 'anilist-access-token-1',
            userId: 42,
            username: 'Test User!',
          }),
        },
      },
      { new: true },
    );
    expect(caller.anilist?.userId).toBe(42);
  });

  it('rejects with 409 when the AniList account belongs to a different user', async () => {
    const { service, model } = makeService();
    model.seed({
      username: 'owner',
      displayName: 'Owner',
      email: 'anilist_42@kaikansen.io',
      passwordHash: OAUTH_PASSWORD_SENTINEL,
      anilist: { accessToken: 't', userId: 42, username: 'Test User!' },
    });
    const caller = model.seed({
      username: 'caller',
      displayName: 'Caller',
      email: 'caller@example.com',
      passwordHash: 'hashed',
    });
    await expect(
      service.anilistLink(caller._id, { code: 'auth-code-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('allows re-linking when the AniList account is already the caller’s', async () => {
    const { service, model } = makeService();
    const caller = model.seed({
      username: 'testuser',
      displayName: 'Test User!',
      email: 'anilist_42@kaikansen.io',
      passwordHash: OAUTH_PASSWORD_SENTINEL,
      anilist: { accessToken: 'old', userId: 42, username: 'Test User!' },
    });
    const res = await service.anilistLink(caller._id, { code: 'auth-code-1' });
    expect(res.linked).toBe(true);
    expect(caller.anilist?.accessToken).toBe('anilist-access-token-1');
  });
});

describe('AniList GET callback redirect (client 56177 landing)', () => {
  const DEST = 'https://preview.example/auth/complete';

  it('success → destination with verifiable tokens + userId in the fragment', async () => {
    const { service, model } = makeService();
    const url = await service.anilistCallbackRedirectUrl('auth-code-1');
    expect(url.startsWith(`${DEST}#`)).toBe(true);
    const fragment = new URLSearchParams(url.slice(DEST.length + 1));
    const access = jwt.verify(
      fragment.get('accessToken') as string,
      ACCESS_SECRET,
    ) as { tokenType: string; userId: string };
    const refresh = jwt.verify(
      fragment.get('refreshToken') as string,
      REFRESH_SECRET,
    ) as { tokenType: string };
    expect(access.tokenType).toBe('access');
    expect(refresh.tokenType).toBe('refresh');
    expect(fragment.get('userId')).toBe(model.users[0]._id);
    expect(access.userId).toBe(model.users[0]._id);
    expect(fragment.get('error')).toBeNull();
  });

  it('missing code → destination with #error=auth_failed', async () => {
    const { service, client } = makeService();
    await expect(
      service.anilistCallbackRedirectUrl(undefined),
    ).resolves.toBe(`${DEST}#error=auth_failed`);
    await expect(service.anilistCallbackRedirectUrl('')).resolves.toBe(
      `${DEST}#error=auth_failed`,
    );
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it('AniList-side exchange failure → #error=exchange_failed', async () => {
    const { service } = makeService({
      client: makeClient({
        exchangeCode: jest.fn(async () => ({ error: 'invalid_client' })),
      }),
    });
    await expect(
      service.anilistCallbackRedirectUrl('some-code'),
    ).resolves.toBe(`${DEST}#error=exchange_failed`);
  });

  it('transport blow-up → #error=internal_error', async () => {
    const { service } = makeService({
      client: makeClient({
        exchangeCode: jest.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });
    await expect(
      service.anilistCallbackRedirectUrl('some-code'),
    ).resolves.toBe(`${DEST}#error=internal_error`);
  });

  it('answers 503 (no redirect) when ANILIST_POST_LOGIN_REDIRECT is unset', async () => {
    const { service } = makeService({
      env: {
        ANILIST_CLIENT_ID: 'test-client-id',
        ANILIST_CLIENT_SECRET: 'test-client-secret',
        ANILIST_REDIRECT_URI: 'https://example.com/oauth/callback',
      },
    });
    await expect(
      service.anilistCallbackRedirectUrl('some-code'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('state=link → bounces the raw code, AniList token endpoint NEVER called, nobody logged in', async () => {
    const { service, model, client } = makeService();
    const url = await service.anilistCallbackRedirectUrl('auth-code-9', 'link');
    expect(url).toBe(`${DEST}#code=auth-code-9&state=link`);
    expect(client.exchangeCode).not.toHaveBeenCalled();
    expect(client.fetchViewer).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
    expect(model.users).toHaveLength(0);
  });

  it('state=link without a code → #error=auth_failed, still no exchange', async () => {
    const { service, client } = makeService();
    await expect(
      service.anilistCallbackRedirectUrl(undefined, 'link'),
    ).resolves.toBe(`${DEST}#error=auth_failed`);
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it('state=login → the exchange happens and tokens land in the fragment', async () => {
    const { service, client } = makeService();
    const url = await service.anilistCallbackRedirectUrl('auth-code-1', 'login');
    expect(client.exchangeCode).toHaveBeenCalledTimes(1);
    expect(url.startsWith(`${DEST}#accessToken=`)).toBe(true);
  });
});
