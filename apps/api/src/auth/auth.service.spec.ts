import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { AuthService, OAUTH_PASSWORD_SENTINEL } from './auth.service';

/**
 * AuthService unit tests. The user model is an in-memory fake (no live
 * DB, no real credentials); bcrypt and JWT run FOR REAL against
 * obviously-fake test secrets, so hashing cost, token lifetimes, secret
 * separation and rotation are exercised honestly.
 */

const ACCESS_SECRET = 'unit-test-access-secret';
const REFRESH_SECRET = 'unit-test-refresh-secret';

const configStub = {
  get: (key: string) =>
    ({ JWT_SECRET: ACCESS_SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET })[key],
} as unknown as ConfigService;

interface FakeUser {
  _id: string;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string;
  avatarUrl: string | null;
  bio: string;
  totalRatings: number;
  totalFollowers: number;
  totalFollowing: number;
  isPublic: boolean;
  anilist?: {
    accessToken?: string;
    userId?: number;
    username?: string;
    syncedAt?: Date;
  };
}

/* Chainable Mongoose-query stand-in (same pattern as themes spec). */
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
            clauses.some((c) => u.email === c.email || u.username === c.username),
          ) ?? null;
      } else if (filter.email) {
        found = users.find((u) => u.email === filter.email) ?? null;
      }
      return queryOf(found);
    }),
    findById: jest.fn((id: string) =>
      queryOf(users.find((u) => u._id === id) ?? null),
    ),
    findByIdAndUpdate: jest.fn(
      (id: string, update: { $set: Record<string, unknown> }) => {
        const doc = users.find((u) => u._id === id) ?? null;
        if (doc && update.$set) {
          Object.assign(doc, update.$set);
        }
        return queryOf(doc);
      },
    ),
    create: jest.fn(async (data: Partial<FakeUser>) => {
      const doc: FakeUser = {
        _id: `fake-user-${++seq}`,
        bio: '',
        avatarUrl: null,
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
        ...(data as FakeUser),
      };
      users.push(doc);
      return doc;
    }),
  };
  return model;
}

function makeService() {
  const model = makeModel();
  const service = new AuthService(model as never, configStub);
  return { model, service };
}

describe('AuthService', () => {
  describe('register', () => {
    it('creates the user, hashes at bcrypt cost 12, returns tokens + profile', async () => {
      const { model, service } = makeService();
      const res = await service.register({
        username: 'Zadid',
        email: 'Zadid@Example.com',
        password: 'hunter2-is-fake',
      });

      // Stored lowercased (web parity), displayName defaults to username.
      expect(model.users).toHaveLength(1);
      const stored = model.users[0];
      expect(stored.username).toBe('zadid');
      expect(stored.email).toBe('zadid@example.com');
      expect(stored.displayName).toBe('Zadid');
      expect(stored.totalRatings).toBe(0);
      expect(stored.isPublic).toBe(true);
      expect(stored.avatarUrl).toContain('dicebear');

      // Real bcrypt hash at cost 12, never the plain password.
      expect(stored.passwordHash).not.toBe('hunter2-is-fake');
      expect(stored.passwordHash.startsWith('$2a$12$')).toBe(true);
      await expect(
        bcrypt.compare('hunter2-is-fake', stored.passwordHash),
      ).resolves.toBe(true);

      // Tokens verify against their own secrets, with the right types.
      const access = jwt.verify(res.accessToken, ACCESS_SECRET) as jwt.JwtPayload;
      expect(access.tokenType).toBe('access');
      expect(access.username).toBe('zadid');
      const refresh = jwt.verify(res.refreshToken, REFRESH_SECRET) as jwt.JwtPayload;
      expect(refresh.tokenType).toBe('refresh');
      expect(() => jwt.verify(res.accessToken, REFRESH_SECRET)).toThrow();

      // Profile carries no passwordHash, ever.
      expect(res.user).toEqual({
        id: stored._id,
        username: 'zadid',
        displayName: 'Zadid',
        email: 'zadid@example.com',
        avatarUrl: stored.avatarUrl,
        bio: '',
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
        anilist: null,
      });
      expect(JSON.stringify(res)).not.toContain('passwordHash');
    });

    it('rejects a duplicate email with the web’s 409', async () => {
      const { service } = makeService();
      await service.register({ username: 'first', email: 'dup@example.com', password: 'pw-one-fake' });
      const err = await service
        .register({ username: 'second', email: 'dup@example.com', password: 'pw-two-fake' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getStatus()).toBe(409);
      expect((err as ConflictException).message).toBe('User already exists');
    });

    it('rejects a duplicate username with the same 409', async () => {
      const { service } = makeService();
      await service.register({ username: 'taken', email: 'one@example.com', password: 'pw-one-fake' });
      const err = await service
        .register({ username: 'TAKEN', email: 'two@example.com', password: 'pw-two-fake' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe('User already exists');
    });

    it('rejects missing fields with the web’s 400', async () => {
      const { service } = makeService();
      const err = await service
        .register({ username: 'x', email: '', password: '' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('All fields required');
    });

    it('Bug 5: wrong-typed fields answer 400, never a 500 TypeError', async () => {
      const cases: Record<string, unknown>[] = [
        { username: 12345, email: 'a@example.com', password: 'pw-fake' },
        { username: 'typed', email: ['a@example.com'], password: 'pw-fake' },
        { username: 'typed', email: 'a@example.com', password: 999 },
        {
          username: 'typed',
          email: 'a@example.com',
          password: 'pw-fake',
          displayName: 42,
        },
      ];
      for (const dto of cases) {
        const { model, service } = makeService();
        const err = await service
          .register(dto as never)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getStatus()).toBe(400);
        expect(model.users).toHaveLength(0);
      }
    });

    it('Bug 5: a valid registration is unaffected by the type guard', async () => {
      const { model, service } = makeService();
      const res = await service.register({
        username: 'typed',
        email: 'typed@example.com',
        password: 'pw-fake',
        displayName: 'Typed User',
      });
      expect(model.users).toHaveLength(1);
      expect(res.user.username).toBe('typed');
      expect(res.user.displayName).toBe('Typed User');
    });
  });

  describe('login', () => {
    it('Bug 5 (login mirror): wrong-typed fields answer 400, never a 500 TypeError', async () => {
      const cases: Record<string, unknown>[] = [
        { email: 12345, password: 'pw-fake' },
        { email: 'a@example.com', password: 999 },
        { email: ['a@example.com'], password: 'pw-fake' },
      ];
      for (const dto of cases) {
        const { service } = makeService();
        const err = await service
          .login(dto as never)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getStatus()).toBe(400);
        expect((err as BadRequestException).message).toBe(
          'Email and password required',
        );
      }
    });

    async function seeded() {
      const ctx = makeService();
      const passwordHash = await bcrypt.hash('correct-fake-password', 12);
      ctx.model.users.push({
        _id: 'seed-1',
        username: 'seeded',
        displayName: 'Seeded User',
        email: 'seeded@example.com',
        passwordHash,
        avatarUrl: null,
        bio: '',
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
      });
      return ctx;
    }

    it('logs in with the right password', async () => {
      const { service } = await seeded();
      const res = await service.login({
        email: 'seeded@example.com',
        password: 'correct-fake-password',
      });
      expect(res.user.username).toBe('seeded');
      expect(res.accessToken).toBeTruthy();
      expect(res.refreshToken).toBeTruthy();
      expect(JSON.stringify(res)).not.toContain('passwordHash');
    });

    it('rejects a wrong password with the web’s 401', async () => {
      const { service } = await seeded();
      const err = await service
        .login({ email: 'seeded@example.com', password: 'wrong-fake-password' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getStatus()).toBe(401);
      expect((err as UnauthorizedException).message).toBe('Invalid credentials');
    });

    it('rejects an unknown email with the same indistinguishable 401', async () => {
      const { service } = await seeded();
      const err = await service
        .login({ email: 'ghost@example.com', password: 'whatever-fake' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid credentials');
    });

    it('rejects password login for AniList-only (sentinel hash) accounts', async () => {
      const { model, service } = await seeded();
      model.users.push({
        _id: 'seed-oauth',
        username: 'anilist_123',
        displayName: 'AniList User',
        email: 'anilist_123@kaikansen.io',
        passwordHash: OAUTH_PASSWORD_SENTINEL,
        avatarUrl: null,
        bio: '',
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
      });
      const err = await service
        .login({ email: 'anilist_123@kaikansen.io', password: 'anything-fake' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid credentials');
    });

    it('rejects missing fields with the web’s 400', async () => {
      const { service } = await seeded();
      const err = await service
        .login({ email: '', password: '' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('Email and password required');
    });
  });

  describe('refresh', () => {
    async function loggedIn() {
      const ctx = makeService();
      const passwordHash = await bcrypt.hash('refresh-fake-password', 12);
      ctx.model.users.push({
        _id: 'seed-r',
        username: 'refresher',
        displayName: 'Refresher',
        email: 'refresh@example.com',
        passwordHash,
        avatarUrl: null,
        bio: '',
        totalRatings: 0,
        totalFollowers: 0,
        totalFollowing: 0,
        isPublic: true,
      });
      const pair = await ctx.service.login({
        email: 'refresh@example.com',
        password: 'refresh-fake-password',
      });
      return { ...ctx, pair };
    }

    it('rotates: issues a fresh pair for a valid refresh token', async () => {
      const { service, pair } = await loggedIn();
      const next = await service.refresh({ refreshToken: pair.refreshToken });
      expect(next.accessToken).toBeTruthy();
      expect(next.refreshToken).toBeTruthy();
      expect(next.refreshToken).not.toBe(pair.refreshToken);
      const payload = jwt.verify(next.accessToken, ACCESS_SECRET) as jwt.JwtPayload;
      expect(payload.username).toBe('refresher');
      // Stateless rotation (O-10 is OPEN): the previous refresh token is
      // NOT revoked — it still rotates again. Asserted so the behaviour
      // is a documented fact, not an accident.
      await expect(
        service.refresh({ refreshToken: pair.refreshToken }),
      ).resolves.toBeTruthy();
    });

    it('rejects a tampered refresh token', async () => {
      const { service, pair } = await loggedIn();
      const tampered = pair.refreshToken.slice(0, -2) + 'xx';
      const err = await service
        .refresh({ refreshToken: tampered })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid refresh token');
    });

    it('rejects an expired refresh token', async () => {
      const { service } = await loggedIn();
      const expired = jwt.sign(
        {
          userId: 'seed-r',
          username: 'refresher',
          email: 'refresh@example.com',
          tokenType: 'refresh',
          exp: Math.floor(Date.now() / 1000) - 60,
        },
        REFRESH_SECRET,
      );
      const err = await service
        .refresh({ refreshToken: expired })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid refresh token');
    });

    it('rejects an ACCESS token presented as a refresh token', async () => {
      const { service, pair } = await loggedIn();
      const err = await service
        .refresh({ refreshToken: pair.accessToken })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid refresh token');
    });

    it('rejects a missing refresh token with the web’s message', async () => {
      const { service } = await loggedIn();
      const err = await service
        .refresh({ refreshToken: '' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('No refresh token');
    });
  });

  describe('me', () => {
    it('returns the profile for an existing user', async () => {
      const { service } = makeService();
      const reg = await service.register({
        username: 'meuser',
        email: 'me@example.com',
        password: 'me-fake-password',
      });
      const profile = await service.me(reg.user.id);
      expect(profile).toEqual(reg.user);
      expect(JSON.stringify(profile)).not.toContain('passwordHash');
    });

    it('exposes the AniList linkage (id + username, never the token) for a linked user', async () => {
      const { model, service } = makeService();
      const seeded = await model.create({
        username: 'linked',
        displayName: 'Linked',
        email: 'linked@example.com',
        passwordHash: 'hashed',
        anilist: {
          accessToken: '<redacted>',
          userId: 42,
          username: 'AniUser',
          syncedAt: new Date(),
        },
      });
      const profile = await service.me(seeded._id);
      expect(profile.anilist).toEqual({ userId: 42, username: 'AniUser' });
      expect(JSON.stringify(profile)).not.toContain('accessToken');
    });

    it('reports anilist: null when the sub-document carries no user id', async () => {
      const { model, service } = makeService();
      const seeded = await model.create({
        username: 'half',
        displayName: 'Half',
        email: 'half@example.com',
        passwordHash: 'hashed',
        anilist: {},
      });
      const profile = await service.me(seeded._id);
      expect(profile.anilist).toBeNull();
    });

    it('rejects an unknown user id', async () => {
      const { service } = makeService();
      await expect(service.me('no-such-user')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('updateProfile', () => {
    async function seeded() {
      const ctx = makeService();
      const reg = await ctx.service.register({
        username: 'editable',
        email: 'edit@example.com',
        password: 'edit-fake-password',
        displayName: 'Original Name',
      });
      ctx.model.findByIdAndUpdate.mockClear();
      return { ...ctx, reg };
    }

    it('edits all three fields and returns the updated profile', async () => {
      const { model, service, reg } = await seeded();
      const res = await service.updateProfile(reg.user.id, {
        displayName: 'New Name',
        bio: 'A short bio',
        avatarUrl: 'https://example.com/avatar.png',
      });
      expect(res).toMatchObject({
        id: reg.user.id,
        displayName: 'New Name',
        bio: 'A short bio',
        avatarUrl: 'https://example.com/avatar.png',
      });
      expect(JSON.stringify(res)).not.toContain('passwordHash');
      const stored = model.users[0];
      expect(stored.displayName).toBe('New Name');
      expect(stored.bio).toBe('A short bio');
      expect(stored.avatarUrl).toBe('https://example.com/avatar.png');
      // What PATCH returns is exactly what GET /auth/me serves.
      await expect(service.me(reg.user.id)).resolves.toEqual(res);
    });

    it('applies a partial update: omitted fields keep their stored values', async () => {
      const { model, service, reg } = await seeded();
      const before = { ...model.users[0] };
      const res = await service.updateProfile(reg.user.id, {
        bio: 'Only the bio changed',
      });
      expect(model.findByIdAndUpdate).toHaveBeenCalledTimes(1);
      expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
        reg.user.id,
        { $set: { bio: 'Only the bio changed' } },
        { new: true },
      );
      expect(res.displayName).toBe(before.displayName);
      expect(res.avatarUrl).toBe(before.avatarUrl);
      expect(model.users[0].displayName).toBe(before.displayName);
    });

    it('an empty patch writes nothing and answers the current profile', async () => {
      const { model, service, reg } = await seeded();
      const res = await service.updateProfile(reg.user.id, {});
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(res).toEqual(reg.user);
    });

    it('avatarUrl: null clears the avatar (the web’s nullable field)', async () => {
      const { service, reg } = await seeded();
      expect(reg.user.avatarUrl).toContain('dicebear');
      const res = await service.updateProfile(reg.user.id, {
        avatarUrl: null,
      });
      expect(res.avatarUrl).toBeNull();
    });

    it('ignores unknown fields — email, username and counters are not editable', async () => {
      const { model, service, reg } = await seeded();
      const res = await service.updateProfile(reg.user.id, {
        displayName: 'Still Me',
        email: 'hijack@example.com',
        username: 'hijacked',
        totalRatings: 999,
      } as never);
      expect(res.displayName).toBe('Still Me');
      expect(res.email).toBe('edit@example.com');
      expect(res.username).toBe('editable');
      expect(model.users[0].totalRatings).toBe(0);
      expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
        reg.user.id,
        { $set: { displayName: 'Still Me' } },
        { new: true },
      );
    });

    it('toggles isPublic: the additive field persists and round-trips through /auth/me', async () => {
      const { model, service, reg } = await seeded();
      expect(reg.user.isPublic).toBe(true);
      const off = await service.updateProfile(reg.user.id, {
        isPublic: false,
      });
      expect(off.isPublic).toBe(false);
      expect(model.users[0].isPublic).toBe(false);
      expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
        reg.user.id,
        { $set: { isPublic: false } },
        { new: true },
      );
      // What PATCH returns is exactly what GET /auth/me serves.
      await expect(service.me(reg.user.id)).resolves.toEqual(off);
      const on = await service.updateProfile(reg.user.id, {
        isPublic: true,
      });
      expect(on.isPublic).toBe(true);
      expect(model.users[0].isPublic).toBe(true);
    });

    it('isPublic is checked after the web fields: avatarUrl keeps first-issue priority', async () => {
      const { model, service, reg } = await seeded();
      const err = await service
        .updateProfile(reg.user.id, {
          isPublic: 'not-a-boolean',
          avatarUrl: 'not-a-url',
        } as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('Invalid URL');
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('accepts the boundary values (50-char name, 200-char bio, empty bio)', async () => {
      const { service, reg } = await seeded();
      const res = await service.updateProfile(reg.user.id, {
        displayName: 'n'.repeat(50),
        bio: 'b'.repeat(200),
      });
      expect(res.displayName).toHaveLength(50);
      expect(res.bio).toHaveLength(200);
      const cleared = await service.updateProfile(reg.user.id, { bio: '' });
      expect(cleared.bio).toBe('');
    });

    const invalidCases: [string, unknown, string][] = [
      [
        'an empty displayName',
        { displayName: '' },
        'Too small: expected string to have >=1 characters',
      ],
      [
        'a 51-char displayName',
        { displayName: 'n'.repeat(51) },
        'Too big: expected string to have <=50 characters',
      ],
      [
        'a 201-char bio',
        { bio: 'b'.repeat(201) },
        'Too big: expected string to have <=200 characters',
      ],
      ['a non-URL avatarUrl', { avatarUrl: 'not-a-url' }, 'Invalid URL'],
      [
        'a numeric displayName',
        { displayName: 42 },
        'Invalid input: expected string, received number',
      ],
      [
        'a null bio',
        { bio: null },
        'Invalid input: expected string, received null',
      ],
      [
        'a boolean avatarUrl',
        { avatarUrl: true },
        'Invalid input: expected string, received boolean',
      ],
      [
        'a non-boolean isPublic',
        { isPublic: 'yes' },
        'Invalid input: expected boolean, received string',
      ],
      [
        'an array body',
        [],
        'Invalid input: expected object, received array',
      ],
      [
        'a string body',
        'just text',
        'Invalid input: expected object, received string',
      ],
      ['a null body', null, 'Invalid input: expected object, received null'],
    ];

    it.each(invalidCases)(
      'rejects %s with the web’s first-issue 400 and writes nothing',
      async (_label, body, message) => {
        const { model, service, reg } = await seeded();
        const err = await service
          .updateProfile(reg.user.id, body as never)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getStatus()).toBe(400);
        expect((err as BadRequestException).message).toBe(message);
        expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
      },
    );

    it('validates the WHOLE body before writing: a valid field is not saved when a sibling is invalid', async () => {
      const { model, service, reg } = await seeded();
      const err = await service
        .updateProfile(reg.user.id, {
          displayName: 'Perfectly Valid',
          bio: 'b'.repeat(201),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(model.users[0].displayName).toBe('Original Name');
    });

    it('reports the first issue in SCHEMA order, not body order (zod parity)', async () => {
      const { service, reg } = await seeded();
      const err = await service
        .updateProfile(reg.user.id, {
          avatarUrl: 'not-a-url',
          bio: 'b'.repeat(201),
          displayName: '',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(
        'Too small: expected string to have >=1 characters',
      );
    });

    it('rejects an unknown user id like GET /auth/me does', async () => {
      const { service } = makeService();
      const err = await service
        .updateProfile('no-such-user', { displayName: 'X' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe(
        'Account no longer exists',
      );
    });
  });

  describe('without a database', () => {
    it('every method answers 503', async () => {
      const service = new AuthService(undefined, configStub);
      await expect(
        service.register({ username: 'x', email: 'x@example.com', password: 'pw' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.login({ email: 'x@example.com', password: 'pw' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.refresh({ refreshToken: 'anything' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.me('x')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(
        service.updateProfile('x', { displayName: 'New' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
