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
  });

  describe('login', () => {
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

    it('rejects an unknown user id', async () => {
      const { service } = makeService();
      await expect(service.me('no-such-user')).rejects.toBeInstanceOf(
        UnauthorizedException,
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
    });
  });
});
