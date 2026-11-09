import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService, OAUTH_PASSWORD_SENTINEL } from './auth.service';
import type { MailerService } from './mailer.service';

/**
 * Password-reset unit tests (new capability — the web has none).
 * In-memory fake user model + a fake mailer that captures what it
 * would have sent (the plaintext code exists only in that capture,
 * exactly as it would exist only in the real email). bcrypt runs
 * for real at cost 12, so hashing of both the code and the new
 * password is exercised honestly.
 */

const configStub = {
  get: (key: string) =>
    ({
      JWT_SECRET: 'unit-test-access-secret',
      JWT_REFRESH_SECRET: 'unit-test-refresh-secret',
    })[key],
} as unknown as ConfigService;

interface FakePasswordReset {
  codeHash: string;
  expiresAt: Date;
  attempts: number;
}

interface FakeUser extends Record<string, unknown> {
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
  tokenVersion?: number;
  passwordReset?: FakePasswordReset;
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
  return {
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
        update: {
          $set?: Record<string, unknown>;
          $unset?: Record<string, unknown>;
        },
      ) => {
        const doc = users.find((u) => u._id === id) ?? null;
        if (doc) {
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$unset) {
            for (const key of Object.keys(update.$unset)) {
              delete doc[key];
            }
          }
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
}

function makeMailer() {
  const sent: { email: string; code: string }[] = [];
  const mailer = {
    sent,
    sendPasswordResetCode: jest.fn(
      async (email: string, code: string): Promise<boolean> => {
        sent.push({ email, code });
        return true;
      },
    ),
  };
  return mailer;
}

function makeService(withMailer = true) {
  const model = makeModel();
  const mailer = makeMailer();
  const service = new AuthService(
    model as never,
    configStub,
    undefined,
    withMailer ? (mailer as unknown as MailerService) : undefined,
  );
  return { model, mailer, service };
}

/** A code guaranteed to differ from the issued one. */
function wrongCode(issued: string): string {
  return issued === '000000' ? '000001' : '000000';
}

const EMAIL = 'reset@example.com';
const OLD_PASSWORD = 'old-password-fake';
const NEW_PASSWORD = 'new-password-fake';

async function registerUser(
  service: AuthService,
  email = EMAIL,
  password = OLD_PASSWORD,
) {
  return service.register({
    username: `user-${email.split('@')[0]}`,
    email,
    password,
  });
}

describe('AuthService password reset', () => {
  // These tests chain many REAL bcrypt cost-12 operations (register
  // hash + code hash + compares + new-password hash ≈ 1.5–4 s of CPU
  // each test, more under parallel load) — the production cost is a
  // security invariant, so the timeout absorbs it instead.
  jest.setTimeout(30_000);


  describe('forgotPassword', () => {
    it('answers the generic 200 for an unknown email and sends nothing', async () => {
      const { mailer, service } = makeService();
      await expect(
        service.forgotPassword({ email: 'ghost@example.com' }),
      ).resolves.toEqual({ ok: true });
      expect(mailer.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('answers the generic 200 for a blank email and sends nothing', async () => {
      const { mailer, service } = makeService();
      await expect(service.forgotPassword({ email: '  ' })).resolves.toEqual({
        ok: true,
      });
      expect(mailer.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('issues a hashed, expiring code and emails it for a real account', async () => {
      const { model, mailer, service } = makeService();
      await registerUser(service);
      const before = Date.now();
      await expect(service.forgotPassword({ email: EMAIL })).resolves.toEqual({
        ok: true,
      });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].email).toBe(EMAIL);
      const code = mailer.sent[0].code;
      expect(code).toMatch(/^\d{6}$/);

      const stored = model.users[0].passwordReset;
      expect(stored).toBeDefined();
      // Only the hash is stored — never the plaintext code.
      expect(stored?.codeHash).not.toBe(code);
      expect(JSON.stringify(model.users[0])).not.toContain(`"${code}"`);
      await expect(
        bcrypt.compare(code, stored?.codeHash as string),
      ).resolves.toBe(true);
      expect(stored?.attempts).toBe(0);
      const expiresAt = stored?.expiresAt as Date;
      expect(expiresAt.getTime()).toBeGreaterThan(before + 14 * 60 * 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 15 * 60 * 1000 + 1000,
      );
    });

    it('sends nothing for an AniList-only account (synthetic email + sentinel hash)', async () => {
      const { model, mailer, service } = makeService();
      await model.create({
        username: 'anilistuser',
        displayName: 'AniList User',
        email: 'anilist_424242@kaikansen.io',
        passwordHash: OAUTH_PASSWORD_SENTINEL,
      });
      await expect(
        service.forgotPassword({ email: 'anilist_424242@kaikansen.io' }),
      ).resolves.toEqual({ ok: true });
      expect(mailer.sendPasswordResetCode).not.toHaveBeenCalled();
      expect(model.users[0].passwordReset).toBeUndefined();
    });

    it('sends nothing for a sentinel-hash account even with a real-looking email', async () => {
      const { model, mailer, service } = makeService();
      await model.create({
        username: 'linkeduser',
        displayName: 'Linked User',
        email: 'linked@example.com',
        passwordHash: OAUTH_PASSWORD_SENTINEL,
      });
      await expect(
        service.forgotPassword({ email: 'linked@example.com' }),
      ).resolves.toEqual({ ok: true });
      expect(mailer.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('still answers 200 and stores the code when no mailer exists (unconfigured)', async () => {
      const { model, service } = makeService(false);
      await registerUser(service);
      await expect(service.forgotPassword({ email: EMAIL })).resolves.toEqual({
        ok: true,
      });
      expect(model.users[0].passwordReset?.codeHash).toBeTruthy();
    });
  });

  describe('resetPassword', () => {
    it('happy path: reset works, old refresh token is revoked, new password logs in', async () => {
      const { model, mailer, service } = makeService();
      const session = await registerUser(service);
      const oldRefreshToken = session.refreshToken;

      await service.forgotPassword({ email: EMAIL });
      const code = mailer.sent[0].code;
      await expect(
        service.resetPassword({ email: EMAIL, code, newPassword: NEW_PASSWORD }),
      ).resolves.toEqual({ reset: true });

      // Code burned (single-use); session generation bumped.
      expect(model.users[0].passwordReset).toBeUndefined();
      expect(model.users[0].tokenVersion).toBe(1);

      // The pre-reset refresh token is revoked.
      await expect(
        service.refresh({ refreshToken: oldRefreshToken }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // Old password is dead; the new one logs in and its refresh works.
      await expect(
        service.login({ email: EMAIL, password: OLD_PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const fresh = await service.login({
        email: EMAIL,
        password: NEW_PASSWORD,
      });
      await expect(
        service.refresh({ refreshToken: fresh.refreshToken }),
      ).resolves.toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });

      // And the used code cannot be replayed.
      await expect(
        service.resetPassword({ email: EMAIL, code, newPassword: 'third-fake' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing fields with 400', async () => {
      const { service } = makeService();
      await expect(
        service.resetPassword({ email: EMAIL, code: '', newPassword: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.resetPassword({ email: EMAIL, code: '123456', newPassword: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown account with the same generic 400', async () => {
      const { service } = makeService();
      await expect(
        service.resetPassword({
          email: 'ghost@example.com',
          code: '123456',
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({ message: 'Invalid or expired reset code' });
    });

    it('counts wrong attempts and burns the code at 5', async () => {
      const { model, mailer, service } = makeService();
      await registerUser(service);
      await service.forgotPassword({ email: EMAIL });
      const code = mailer.sent[0].code;
      const wrong = wrongCode(code);

      for (let i = 1; i <= 4; i++) {
        await expect(
          service.resetPassword({ email: EMAIL, code: wrong, newPassword: 'x' }),
        ).rejects.toMatchObject({ message: 'Invalid or expired reset code' });
        expect(model.users[0].passwordReset?.attempts).toBe(i);
      }
      // The 5th failure burns the code entirely.
      await expect(
        service.resetPassword({ email: EMAIL, code: wrong, newPassword: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.users[0].passwordReset).toBeUndefined();
      // Even the correct code is dead now.
      await expect(
        service.resetPassword({
          email: EMAIL,
          code,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still accepts the correct code after a few wrong attempts', async () => {
      const { mailer, service } = makeService();
      await registerUser(service);
      await service.forgotPassword({ email: EMAIL });
      const code = mailer.sent[0].code;
      const wrong = wrongCode(code);
      await expect(
        service.resetPassword({ email: EMAIL, code: wrong, newPassword: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.resetPassword({
          email: EMAIL,
          code,
          newPassword: NEW_PASSWORD,
        }),
      ).resolves.toEqual({ reset: true });
    });

    it('rejects an expired code and clears it', async () => {
      const { model, mailer, service } = makeService();
      await registerUser(service);
      await service.forgotPassword({ email: EMAIL });
      const code = mailer.sent[0].code;
      const stored = model.users[0].passwordReset as FakePasswordReset;
      model.users[0].passwordReset = {
        ...stored,
        expiresAt: new Date(Date.now() - 1000),
      };
      await expect(
        service.resetPassword({
          email: EMAIL,
          code,
          newPassword: NEW_PASSWORD,
        }),
      ).rejects.toMatchObject({ message: 'Invalid or expired reset code' });
      expect(model.users[0].passwordReset).toBeUndefined();
    });

    it('a second forgot request invalidates the first code', async () => {
      const { mailer, service } = makeService();
      await registerUser(service);
      await service.forgotPassword({ email: EMAIL });
      const firstCode = mailer.sent[0].code;
      await service.forgotPassword({ email: EMAIL });
      const secondCode = mailer.sent[1].code;
      // The two codes could theoretically collide (1 in a million);
      // only assert invalidation when they actually differ.
      if (firstCode !== secondCode) {
        await expect(
          service.resetPassword({
            email: EMAIL,
            code: firstCode,
            newPassword: NEW_PASSWORD,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        service.resetPassword({
          email: EMAIL,
          code: secondCode,
          newPassword: NEW_PASSWORD,
        }),
      ).resolves.toEqual({ reset: true });
    });
  });
});
