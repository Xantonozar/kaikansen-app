import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'crypto';
import type {
  AnilistCallbackRequest,
  AnilistLinkRequest,
  AnilistLinkResponse,
  AnilistUrlResponse,
  AuthResponse,
  AuthTokens,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  LogoutResponse,
  RefreshRequest,
  RegisterRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  UpdateProfileRequest,
  UserProfile,
} from '@kaikansen/contracts';
import {
  AnilistClient,
  type AnilistConfig,
  type AnilistViewer,
} from './anilist.client';
import { MailerService } from './mailer.service';
import { User, type RefreshSession, type UserDocument } from './user.schema';
import { Rating, type RatingDocument } from '../library/rating.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { Follow, type FollowDocument } from '../social/follow.schema';
import { computeProfileStats } from '../users/profile-stats';

/**
 * Password-login is impossible for AniList-created accounts: the web
 * stores this sentinel instead of a bcrypt hash (AUDIT.md §3). A bcrypt
 * compare against it never matches — and we reject it explicitly, as a
 * named invariant (SECURITY_PRIVACY.md SEC-07), before comparing.
 */
export const OAUTH_PASSWORD_SENTINEL = 'OAUTH_USER_NO_PASSWORD';

/** bcrypt cost — parity with the web (SECURITY_PRIVACY.md SEC-01). */
const BCRYPT_COST = 12;

/** Token lifetimes — parity with the web (audit §3). */
const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

/** Password-reset code lifetime: 15 minutes from issue. */
const RESET_CODE_TTL_MS = 15 * 60 * 1000;

/** Failed verifications tolerated before a reset code is burned. */
const RESET_CODE_MAX_ATTEMPTS = 5;

/**
 * The synthetic email shape AniList-created accounts are stored
 * under (see issueAnilistSession). Such accounts have no password
 * to reset — they are also caught by the sentinel-hash check; this
 * pattern is the belt to that check's braces.
 */
const SYNTHETIC_ANILIST_EMAIL = /^anilist_\d+@kaikansen\.io$/;

/** DiceBear avatar pool assigned at registration — the web's own list. */
const REGISTRATION_AVATARS = [
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Lucky&backgroundColor=b6e3f4',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Bear&backgroundColor=c0aede',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Kitty&backgroundColor=ffdfbf',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Sunny&backgroundColor=ffd5dc',
  'https://api.dicebear.com/7.x/adventurer/svg?seed=Mochi&backgroundColor=d1d4f9',
];

/** Claims carried by both token types (web payload + a type marker). */
export interface TokenPayload {
  userId: string;
  username: string;
  email: string;
  /**
   * 'access' | 'refresh'. The web distinguishes the two tokens only by
   * which secret signed them; we additionally mark the type so a token
   * can never be replayed against the other role. (The backend's secrets
   * are its own — SECURITY_PRIVACY.md SEC-02 — so web-issued tokens
   * never verify here anyway.)
   */
  tokenType: 'access' | 'refresh';
  /**
   * The user's session generation at mint time (User.tokenVersion).
   * Only the refresh path reads it: a password reset increments the
   * stored counter, which is what revokes refresh tokens issued
   * before the reset. Tokens minted before this claim existed read
   * as version 0.
   */
  tokenVersion: number;
  /**
   * Refresh tokens only: the tracked session family's id
   * (User.refreshSessions[].familyId) and the token's own id
   * (the JWT `jti`, set via the sign options — jsonwebtoken puts
   * it on the verified payload). Rotation + reuse detection key
   * off the pair; access tokens carry neither. Both absent on
   * refresh tokens minted before session tracking existed (the
   * refresh path adopts those once — see AuthService.refresh).
   */
  fid?: string;
  jti?: string;
}

/** One tracked refresh family, as the service layer manipulates it. */
type RefreshSessionState = RefreshSession;

/** Tracked refresh families kept per user; the oldest is pruned. */
const MAX_REFRESH_SESSIONS = 5;

/** Rotated-out jtis remembered per family for reuse detection. */
const USED_JTI_CAP = 50;

/**
 * Auth over the shared `users` collection (Slice 2).
 *
 * Behaviour is a port of the web app's auth routes
 * (ZadidSalman/Kaisen `app/api/auth/*` + `lib/auth.ts`): same validation
 * messages, same duplicate handling, same lifetimes, bcrypt cost 12.
 * Two native-first deviations, both deliberate:
 *  1. The refresh token travels in the JSON body both ways (the web
 *     reads it only from an httpOnly cookie) — SECURITY_PRIVACY.md SEC-03.
 *  2. Refresh ROTATES: a fresh access+refresh pair is issued (the web
 *     re-issues only an access token). Rotation is TRACKED (owner
 *     order 2026-11-10, audit S1 — settling OPEN item O-10 for this
 *     API): every login starts a refresh family on the user record;
 *     rotation retires the presented token's jti into the family's
 *     used list, and presenting a retired jti again is REUSE — the
 *     whole family is revoked (a stolen, already-rotated token can
 *     no longer live out its 7 days). POST /auth/logout clears the
 *     families and bumps the session generation, so logout is real
 *     server-side. The generation hook still applies on top: refresh
 *     compares the token's tokenVersion claim against the user
 *     record, and a password reset increments the stored version,
 *     revoking every refresh token issued before it. Access tokens
 *     are never checked against the database (their 15-minute TTL
 *     bounds them). The website's own auth is untouched by all of
 *     this: its tokens are signed with its own secrets and its user
 *     fields are unchanged — the families live in an additive,
 *     API-only field the web never reads.
 *
 * The model is OPTIONAL like the themes model: booted without
 * MONGODB_URI, every method answers 503 while /health keeps working.
 */
@Injectable()
export class AuthService {
  constructor(
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    private readonly config?: ConfigService,
    @Optional()
    private readonly anilist?: AnilistClient,
    @Optional()
    private readonly mailer?: MailerService,
    /**
     * Read-only models for the profile listening stats
     * (GET /auth/me's `stats` — see withStats). Optional like the
     * user model: AuthModule registers them with a database;
     * the AuthService instances other modules provide for token
     * verification don't, and simply never serve /auth/me.
     */
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(Follow.name)
    private readonly followModel?: Model<FollowDocument>,
  ) {}

  private requireModel(): Model<UserDocument> {
    if (!this.userModel) {
      throw new ServiceUnavailableException(
        'Auth unavailable — API booted without MONGODB_URI',
      );
    }
    return this.userModel;
  }

  /**
   * Secrets come from the deployment environment (JWT_SECRET /
   * JWT_REFRESH_SECRET — see .env.example; SEC-02: the backend's own
   * secrets, distinct from the website's, never committed). The fallback
   * strings mirror the web's dev fallbacks so a local boot behaves the
   * same way the web's does; production must set real values.
   */
  private secret(kind: 'access' | 'refresh'): string {
    const name = kind === 'access' ? 'JWT_SECRET' : 'JWT_REFRESH_SECRET';
    const fallback =
      kind === 'access'
        ? 'fallback-secret-change-me'
        : 'fallback-refresh-secret-change-me';
    return this.config?.get<string>(name) ?? fallback;
  }

  private signPair(
    claims: Omit<TokenPayload, 'tokenType' | 'fid' | 'jti'>,
    session: { familyId: string; jti: string },
  ): AuthTokens {
    const accessToken = jwt.sign(
      { ...claims, tokenType: 'access' },
      this.secret('access'),
      { expiresIn: ACCESS_TTL },
    );
    const refreshToken = jwt.sign(
      { ...claims, tokenType: 'refresh', fid: session.familyId },
      this.secret('refresh'),
      // The session's jti as the jwtid: without a unique id, a login
      // and a refresh inside the same second would mint
      // byte-identical tokens (same claims, same iat/exp) and
      // "rotation" would be a no-op. The id is also the rotation
      // tracker — the family record on the user stores it.
      { expiresIn: REFRESH_TTL, jwtid: session.jti },
    );
    return { accessToken, refreshToken };
  }

  /** The user's tracked refresh families (the field is select:false). */
  private async readSessions(
    model: Model<UserDocument>,
    userId: string,
  ): Promise<RefreshSessionState[]> {
    const user = await model
      .findById(userId)
      .select('+refreshSessions')
      .exec();
    return (user?.refreshSessions ?? []).map((s) => ({
      familyId: s.familyId,
      currentJti: s.currentJti,
      usedJtis: [...(s.usedJtis ?? [])],
      createdAt: s.createdAt,
    }));
  }

  /** Replaces the user's tracked families in one $set (the logout /
   *  cap / rotation writes all go through here). */
  private async writeSessions(
    model: Model<UserDocument>,
    userId: string,
    sessions: RefreshSessionState[],
  ): Promise<void> {
    await model
      .findByIdAndUpdate(userId, { $set: { refreshSessions: sessions } })
      .exec();
  }

  /**
   * Starts a NEW refresh family for the user and mints its first
   * pair (login / register / AniList session / legacy adoption in
   * refresh). Families are capped: the oldest is pruned past
   * MAX_REFRESH_SESSIONS, so a user with many stale logins sheds
   * them instead of accumulating session rows forever.
   */
  private async issueSession(
    model: Model<UserDocument>,
    user: UserDocument,
  ): Promise<AuthTokens> {
    const familyId = randomUUID();
    const jti = randomUUID();
    const sessions = await this.readSessions(model, user._id.toString());
    sessions.push({
      familyId,
      currentJti: jti,
      usedJtis: [],
      createdAt: new Date(),
    });
    await this.writeSessions(
      model,
      user._id.toString(),
      sessions.slice(-MAX_REFRESH_SESSIONS),
    );
    return this.signPair(
      {
        userId: user._id.toString(),
        username: user.username,
        email: user.email,
        tokenVersion: user.tokenVersion ?? 0,
      },
      { familyId, jti },
    );
  }

  /** Verifies an access token (used by AccessTokenGuard). */
  verifyAccessToken(token: string): TokenPayload | null {
    try {
      const payload = jwt.verify(token, this.secret('access')) as TokenPayload;
      return payload.tokenType === 'access' ? payload : null;
    } catch {
      return null;
    }
  }

  private toProfile(user: UserDocument): UserProfile {
    return {
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      totalRatings: user.totalRatings,
      totalFollowers: user.totalFollowers,
      totalFollowing: user.totalFollowing,
      isPublic: user.isPublic,
      // The web /api/users/me shape, verbatim: the linkage is exposed
      // only when an AniList user id is actually stored, and the stored
      // access token NEVER leaves the API. This is what lets the app
      // persist "AniList linked" across restarts instead of holding it
      // in session-local state.
      anilist:
        user.anilist && user.anilist.userId
          ? {
              userId: user.anilist.userId,
              username: user.anilist.username as string,
            }
          : null,
    };
  }

  /** POST /auth/register — the web's app/api/auth/register/route.ts. */
  async register(dto: RegisterRequest): Promise<AuthResponse> {
    const model = this.requireModel();
    const { username, email, password } = dto ?? ({} as RegisterRequest);
    if (!username || !email || !password) {
      // Web message — its form also requires displayName; here displayName
      // is optional and defaults to the username (see contracts).
      throw new BadRequestException('All fields required');
    }
    // Bug 5 (multi-user matrix 2026-11-09): the presence check
    // passes truthy non-strings (username: 12345, email: [...],
    // password: 999), which then died on .toLowerCase() / bcrypt
    // as a 500. Wrong-typed fields are a client error — the same
    // typeof validation the rest of the codebase applies
    // (playlists/comments validators, this file's profile-update
    // helpers below).
    if (
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      (dto.displayName != null && typeof dto.displayName !== 'string')
    ) {
      throw new BadRequestException('All fields required');
    }

    const cleanUsername = username.toLowerCase();
    const cleanEmail = email.toLowerCase();
    // Web parity: one probe for either identifier, one 409 message —
    // 'User already exists' covers a duplicate email AND a duplicate
    // username indistinguishably. Both identifiers are probed in the
    // lowercased form they will be stored in (the web probes the raw
    // email; for any email the web itself stored — always lowercase —
    // the outcome is identical).
    const existing = await model
      .findOne({ $or: [{ email: cleanEmail }, { username: cleanUsername }] })
      .exec();
    if (existing) {
      throw new ConflictException('User already exists');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const avatarUrl =
      REGISTRATION_AVATARS[
        Math.floor(Math.random() * REGISTRATION_AVATARS.length)
      ];
    const user = await model.create({
      username: cleanUsername,
      displayName: dto.displayName?.trim() || username,
      email: cleanEmail,
      passwordHash,
      avatarUrl,
    });

    const tokens = await this.issueSession(model, user);
    return { ...tokens, user: this.toProfile(user) };
  }

  /** POST /auth/login — the web's app/api/auth/login/route.ts. */
  async login(dto: LoginRequest): Promise<AuthResponse> {
    const model = this.requireModel();
    const { email, password } = dto ?? ({} as LoginRequest);
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email ||
      !password
    ) {
      throw new BadRequestException('Email and password required');
    }

    // Web parity, exactly: the lookup uses the email AS PROVIDED (the
    // web lowercases emails at registration but does not lowercase the
    // login lookup — a mixed-case login email misses a lowercase-stored
    // account there too. Flagged in the slice report; not "fixed" here,
    // because silent fixes are how ports drift from their source.)
    const user = await model
      .findOne({ email })
      .select('+passwordHash')
      .exec();

    // One indistinguishable 401 for unknown email, wrong password and
    // AniList-only accounts (SEC-07) — the web's behaviour for all three.
    if (!user || user.passwordHash === OAUTH_PASSWORD_SENTINEL) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueSession(model, user);
    return { ...tokens, user: this.toProfile(user) };
  }

  /** POST /auth/refresh — body-carried refresh token, rotated pair out. */
  async refresh(dto: RefreshRequest): Promise<AuthTokens> {
    const model = this.requireModel();
    const refreshToken = dto?.refreshToken;
    if (!refreshToken) {
      // The web's message for a missing refresh credential.
      throw new UnauthorizedException('No refresh token');
    }
    let payload: TokenPayload;
    try {
      payload = jwt.verify(
        refreshToken,
        this.secret('refresh'),
      ) as TokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // REVOCATION CHECK: the token's session generation must still be
    // the user's current one. A password reset (or a logout)
    // increments the stored tokenVersion, so every refresh token
    // minted before it dies here (a deleted account's tokens die
    // with it). Tokens minted before the claim existed read as
    // version 0.
    const user = await model.findById(payload.userId).exec();
    if (!user || (payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const userId = user._id.toString();
    const claims = {
      userId,
      username: payload.username,
      email: payload.email,
      tokenVersion: user.tokenVersion ?? 0,
    };

    // SESSION TRACKING (audit S1): the presented token must be its
    // family's CURRENT token. A retired jti presented again is
    // reuse — the family is revoked before answering, so neither
    // the thief's copy nor the victim's current token works again
    // (the victim simply logs in fresh; every other family of
    // theirs is untouched).
    const sessions = await this.readSessions(model, userId);
    if (payload.fid && payload.jti) {
      const family = sessions.find((s) => s.familyId === payload.fid);
      if (!family) {
        // Unknown family: logged out, pruned, or already revoked.
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (family.usedJtis.includes(payload.jti)) {
        await this.writeSessions(
          model,
          userId,
          sessions.filter((s) => s.familyId !== payload.fid),
        );
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (payload.jti !== family.currentJti) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      // ROTATE: retire the presented jti, mint the pair on a fresh
      // one — same family, new current.
      const nextJti = randomUUID();
      family.usedJtis = [...family.usedJtis, payload.jti].slice(
        -USED_JTI_CAP,
      );
      family.currentJti = nextJti;
      await this.writeSessions(model, userId, sessions);
      return this.signPair(claims, { familyId: payload.fid, jti: nextJti });
    }

    // LEGACY token (minted before session tracking: it carries a
    // jti but no family id). If that jti was already retired under
    // tracking, this presentation is a replay — revoke the family
    // that recorded it. Otherwise adopt the token once: the pair
    // it rotates into starts a tracked family, with the legacy jti
    // recorded as used so a later replay is caught above.
    if (payload.jti) {
      const recorded = sessions.find((s) =>
        s.usedJtis.includes(payload.jti as string),
      );
      if (recorded) {
        await this.writeSessions(
          model,
          userId,
          sessions.filter((s) => s.familyId !== recorded.familyId),
        );
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (sessions.length > 0) {
        const familyId = randomUUID();
        const jti = randomUUID();
        sessions.push({
          familyId,
          currentJti: jti,
          usedJtis: [payload.jti],
          createdAt: new Date(),
        });
        await this.writeSessions(
          model,
          userId,
          sessions.slice(-MAX_REFRESH_SESSIONS),
        );
        return this.signPair(claims, { familyId, jti });
      }
    }
    // No tracking state at all (pre-tracking account, or every
    // family pruned with the generation still current): start
    // fresh tracking for the rotated pair.
    return this.issueSession(model, user);
  }

  /**
   * POST /auth/logout — REAL server-side logout (audit S1): every
   * tracked refresh family is cleared AND the session generation
   * is bumped, so every refresh token the user holds — tracked or
   * legacy — stops working immediately, on every device. (Their
   * other devices' access tokens live out their ≤15 minutes, as
   * always.) The mobile client calls this best-effort before
   * clearing its local session; a failed call changes nothing
   * locally.
   */
  async logout(userId: string): Promise<LogoutResponse> {
    const model = this.requireModel();
    const user = await model
      .findByIdAndUpdate(userId, {
        $set: { refreshSessions: [] },
        $inc: { tokenVersion: 1 },
      })
      .exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* Password reset — a NEW capability (the web has none: its login   */
  /* form links to a /forgot-password page that does not exist, and   */
  /* no email pipeline exists anywhere in the web codebase). The      */
  /* flow is code-based because the product is app-only: a 6-digit    */
  /* code is emailed (Brevo — see MailerService), stored only as a    */
  /* bcrypt hash on the user document, valid 15 minutes, single-use,  */
  /* burned after 5 failed verifications.                             */
  /* ---------------------------------------------------------------- */

  /**
   * POST /auth/forgot-password — ALWAYS answers the same generic
   * 200, whether or not the address belongs to an account: nothing
   * in the response (or its timing-critical path) may reveal
   * existence. A code is issued ONLY when a real password account
   * exists for the address — never for AniList-created accounts
   * (sentinel password hash; synthetic `anilist_<id>@kaikansen.io`
   * email) — and issuing a code replaces any previous one. When the
   * mailer is unconfigured the send is skipped (logged, without the
   * code) and the answer is still the generic 200.
   *
   * The address is trimmed + lowercased before lookup: accounts are
   * stored lowercased (registration), and this flow — unlike login,
   * whose as-provided lookup is a mirrored web quirk — has no web
   * behaviour to mirror.
   */
  async forgotPassword(
    dto: ForgotPasswordRequest,
  ): Promise<ForgotPasswordResponse> {
    const model = this.requireModel();
    const email = (dto?.email ?? '').trim().toLowerCase();
    if (email) {
      const user = await model
        .findOne({ email })
        .select('+passwordHash')
        .exec();
      if (
        user &&
        user.passwordHash !== OAUTH_PASSWORD_SENTINEL &&
        !SYNTHETIC_ANILIST_EMAIL.test(email)
      ) {
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        // bcrypt-hashed like a password (cost 12): the code space is
        // only a million, so a fast hash would fall instantly to an
        // offline brute force if the database ever leaked.
        const codeHash = await bcrypt.hash(code, BCRYPT_COST);
        await model
          .findByIdAndUpdate(user._id, {
            $set: {
              passwordReset: {
                codeHash,
                expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
                attempts: 0,
              },
            },
          })
          .exec();
        // A skipped/failed send changes nothing about the response.
        await this.mailer?.sendPasswordResetCode(email, code);
      }
    }
    return { ok: true };
  }

  /**
   * POST /auth/reset-password — verifies the emailed code and sets
   * the new password with the register flow's hashing (bcrypt,
   * cost 12) and its only password rule (presence — the web's
   * register imposes no length or composition rule). EVERY code
   * failure — unknown account, no pending code, expired code,
   * wrong code, burned code — answers the same generic 400, so the
   * endpoint leaks nothing about which check failed.
   *
   * On success the code is burned (single-use) and the user's
   * tokenVersion is incremented in the same write, revoking every
   * refresh token issued before the reset.
   */
  async resetPassword(
    dto: ResetPasswordRequest,
  ): Promise<ResetPasswordResponse> {
    const model = this.requireModel();
    const email = (dto?.email ?? '').trim().toLowerCase();
    const code = (dto?.code ?? '').trim();
    const newPassword = dto?.newPassword;
    if (!email || !code || !newPassword) {
      throw new BadRequestException('Email, code and new password required');
    }
    const reject = (): never => {
      throw new BadRequestException('Invalid or expired reset code');
    };

    const user = await model
      .findOne({ email })
      .select('+passwordReset')
      .exec();
    const pending = user?.passwordReset;
    if (!user || !pending?.codeHash || !pending?.expiresAt) {
      reject();
    }
    // The guards above narrow both to defined values.
    const account = user as UserDocument;
    const stored = pending as {
      codeHash: string;
      expiresAt: Date;
      attempts?: number;
    };

    if (stored.expiresAt.getTime() <= Date.now()) {
      // Expired codes are cleared, not left to linger.
      await model
        .findByIdAndUpdate(account._id, { $unset: { passwordReset: '' } })
        .exec();
      reject();
    }

    const matches = await bcrypt.compare(code, stored.codeHash);
    if (!matches) {
      const attempts = (stored.attempts ?? 0) + 1;
      if (attempts >= RESET_CODE_MAX_ATTEMPTS) {
        // Attempt cap reached — the code is burned; even the correct
        // code no longer works and a fresh one must be requested.
        await model
          .findByIdAndUpdate(account._id, { $unset: { passwordReset: '' } })
          .exec();
      } else {
        await model
          .findByIdAndUpdate(account._id, {
            $set: {
              passwordReset: {
                codeHash: stored.codeHash,
                expiresAt: stored.expiresAt,
                attempts,
              },
            },
          })
          .exec();
      }
      reject();
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await model
      .findByIdAndUpdate(account._id, {
        $set: {
          passwordHash,
          tokenVersion: (account.tokenVersion ?? 0) + 1,
          // The generation bump already revokes every refresh
          // token; clearing the tracked families too keeps the
          // session list honest (nothing lingers to be pruned).
          refreshSessions: [],
        },
        $unset: { passwordReset: '' },
      })
      .exec();
    return { reset: true };
  }

  /**
   * The profile WITH its listening stats attached (GET /auth/me
   * and PATCH /auth/me — the reads the own-Profile screen
   * consumes). The aggregates come from the shared routine
   * (computeProfileStats — the same one GET /users/:username
   * uses, so both surfaces agree). When this instance was built
   * without the stats models the profile answers without `stats`
   * rather than failing — the field is optional in the contract
   * for exactly that case (and for the register/login payloads,
   * which never attach it).
   */
  private async withStats(user: UserDocument): Promise<UserProfile> {
    const profile = this.toProfile(user);
    if (
      !this.ratingModel ||
      !this.historyModel ||
      !this.themeModel ||
      !this.followModel
    ) {
      return profile;
    }
    return {
      ...profile,
      stats: await computeProfileStats(
        {
          ratings: this.ratingModel,
          history: this.historyModel,
          themes: this.themeModel,
          follows: this.followModel,
        },
        user,
      ),
    };
  }

  /** GET /auth/me — profile for the bearer token's user. */
  async me(userId: string): Promise<UserProfile> {
    const model = this.requireModel();
    const user = await model.findById(userId).exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return this.withStats(user);
  }

  /**
   * PATCH /auth/me — the web's PATCH /api/users/me (this API's /auth/me
   * is where the web's /api/users/me GET already lives, so the edit
   * hangs off the same path): validate the WHOLE body first (the web's
   * zod schema — see parseProfileUpdate, whose messages are zod v4's
   * first-issue texts, verified against the web's zod), then write
   * ONCE with a $set of exactly the provided fields. Omitted fields
   * keep their stored values; unknown fields are ignored, as the
   * web's parser strips them. A body with no editable fields answers
   * the current profile, like the web's empty-$set update.
   *
   * Not-found follows THIS API's /auth/me convention (401 'Account no
   * longer exists' — see me()) rather than the web route's 404, so
   * the paired read/edit endpoints answer consistently.
   */
  async updateProfile(
    userId: string,
    dto: UpdateProfileRequest,
  ): Promise<UserProfile> {
    const model = this.requireModel();
    const updates = parseProfileUpdate(dto);
    if (Object.keys(updates).length === 0) {
      return this.me(userId);
    }
    const user = await model
      .findByIdAndUpdate(userId, { $set: updates }, { new: true })
      .exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return this.withStats(user);
  }

  /* ---------------------------------------------------------------- */
  /* AniList OAuth — a native port of the web's                        */
  /* app/api/auth/anilist/url + /callback routes.                      */
  /*                                                                   */
  /* The web flow is browser-shaped (redirect + popup postMessage +    */
  /* refresh-cookie session detection for linking). Here the same      */
  /* semantics ride the API's shapes instead: the authorize URL is     */
  /* handed out as JSON, the code comes back in a POST body, login     */
  /* answers with the standard token pair, and linking hangs off the   */
  /* Bearer guard instead of the cookie. Storage mirrors the web: the  */
  /* AniList access token sits in PLAINTEXT on the user doc (OPEN      */
  /* item O-05 — mirror now, harden later). ONE deliberate safety      */
  /* deviation: the web's link overwrites unconditionally, even if     */
  /* that AniList account already belongs to another user; this API    */
  /* refuses with 409 instead of silently stealing the link.           */
  /* ---------------------------------------------------------------- */

  /**
   * The AniList env trio (ANILIST_CLIENT_ID / ANILIST_CLIENT_SECRET /
   * ANILIST_REDIRECT_URI — names only in .env.example), trimmed exactly
   * as the web trims them. Unset-or-blank on ANY of the three means
   * AniList login is unconfigured: the AniList endpoints answer 503,
   * like the model-less 503s, while the rest of auth keeps working.
   * (The web answers 500 with a "missing in Vercel" message instead —
   * its env is Vercel's; the status/message here follow this API's
   * unavailable-service convention.)
   */
  private anilistConfig(): AnilistConfig | null {
    const read = (name: string): string =>
      (this.config?.get<string>(name) ?? '').trim();
    const config: AnilistConfig = {
      clientId: read('ANILIST_CLIENT_ID'),
      clientSecret: read('ANILIST_CLIENT_SECRET'),
      redirectUri: read('ANILIST_REDIRECT_URI'),
    };
    return config.clientId && config.clientSecret && config.redirectUri
      ? config
      : null;
  }

  private requireAnilistConfig(): AnilistConfig {
    const config = this.anilistConfig();
    if (!config || !this.anilist) {
      throw new ServiceUnavailableException(
        'AniList login unavailable — API booted without the AniList configuration',
      );
    }
    return config;
  }

  /** GET /auth/anilist/url — the web's url route, as JSON. */
  async anilistUrl(state?: string): Promise<AnilistUrlResponse> {
    this.requireModel();
    const config = this.requireAnilistConfig();
    // Built exactly as the web builds it (URLSearchParams, this order).
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
    });
    // `state` is the caller's intent switch ('login' | 'link'), passed
    // through untouched — AniList echoes it back to the callback,
    // where the GET handler branches on it. Absent = default (login).
    const intent = (state ?? '').trim();
    if (intent) {
      params.set('state', intent);
    }
    return {
      url: `https://anilist.co/api/v2/oauth/authorize?${params.toString()}`,
    };
  }

  /**
   * The shared first half of callback + link: exchange the code
   * server-side, then fetch the viewer — the web callback's steps and
   * failure messages, in order.
   */
  private async exchangeAndFetchViewer(
    code: string | undefined,
    config: AnilistConfig,
  ): Promise<{ viewer: AnilistViewer; accessToken: string }> {
    if (!code) {
      // The web's response for a missing/failed authorization.
      throw new BadRequestException('Auth failed or cancelled');
    }
    const client = this.anilist as AnilistClient;
    let token: Awaited<ReturnType<AnilistClient['exchangeCode']>>;
    let viewer: AnilistViewer | null;
    try {
      token = await client.exchangeCode(config, code);
      viewer = token.accessToken
        ? await client.fetchViewer(token.accessToken)
        : null;
    } catch {
      // Network/parse failure reaching AniList — the web's catch-all.
      throw new InternalServerErrorException('Internal server error');
    }
    if (!token.accessToken) {
      // The web callback's mapping of AniList's token errors (its
      // 'check your Vercel Environment Variables' becomes the server's
      // environment here — the meaning is the deployment env).
      const message =
        token.error === 'invalid_client'
          ? 'AniList rejected your Client ID/Secret. Please check the server environment variables.'
          : (token.message ?? token.error ?? 'Failed to exchange token');
      throw new BadGatewayException(message);
    }
    if (!viewer) {
      throw new BadGatewayException('Failed to fetch AniList profile');
    }
    return { viewer, accessToken: token.accessToken };
  }

  /** POST /auth/anilist/callback — find-or-create, then a token pair. */
  async anilistCallback(dto: AnilistCallbackRequest): Promise<AuthResponse> {
    const model = this.requireModel();
    const config = this.requireAnilistConfig();
    const { viewer, accessToken } = await this.exchangeAndFetchViewer(
      dto?.code,
      config,
    );
    return this.issueAnilistSession(model, viewer, accessToken);
  }

  /**
   * GET /auth/anilist/callback — the server-side redirect variant.
   *
   * AniList client 56177's registered redirect URL points at THIS API
   * (https://kaikansen-api.onrender.com/api/v1/auth/anilist/callback),
   * so AniList sends the browser here directly with ?code=… . The
   * endpoint runs the same exchange + find-or-create as the POST, then
   * 302s to ANILIST_POST_LOGIN_REDIRECT with the session in the URL
   * FRAGMENT (#accessToken=…&refreshToken=…&userId=…) — fragments are
   * never sent to servers or written to access logs, and the app /
   * web preview reads them client-side.
   *
   * Failures redirect too, with #error=<short code> instead of tokens
   * (missing/cancelled code → auth_failed; AniList-side exchange or
   * profile failure → exchange_failed; anything else → internal_error)
   * — a browser flow should land back in the app with an error, not
   * strand the user on a JSON error page. Only CONFIGURATION problems
   * (no DB, AniList env trio unset, or ANILIST_POST_LOGIN_REDIRECT
   * unset) answer 503 JSON like the other endpoints, with no redirect.
   *
   * STATE SWITCH: the `state` value the caller put on the authorize
   * URL (via GET /auth/anilist/url?state=…) is echoed back here by
   * AniList. Absent or 'login' → the login flow above. 'link' → NO
   * exchange, NO login: the raw code is bounced to the destination as
   * #code=…&state=link for the authenticated app to POST to
   * /auth/anilist/link itself (see the branch below for why).
   */
  async anilistCallbackRedirectUrl(
    code: string | undefined,
    state?: string,
  ): Promise<string> {
    const model = this.requireModel();
    const config = this.requireAnilistConfig();
    const destination = (
      this.config?.get<string>('ANILIST_POST_LOGIN_REDIRECT') ?? ''
    ).trim();
    if (!destination) {
      throw new ServiceUnavailableException(
        'AniList login unavailable — API booted without ANILIST_POST_LOGIN_REDIRECT',
      );
    }
    if (state === 'link') {
      // LINK INTENT — do NOT exchange the code and do NOT log in here.
      // Linking must be bound to the caller's existing session, and a
      // browser redirect cannot carry the app's Bearer token — so the
      // API hands the raw code back to the already-authenticated app
      // in the fragment, and the app POSTs it to /auth/anilist/link
      // with its Bearer header, where the binding (and the 409
      // conflict check) actually happens.
      if (!code) {
        return `${destination}#error=auth_failed`;
      }
      const fragment = new URLSearchParams({ code, state: 'link' });
      return `${destination}#${fragment.toString()}`;
    }
    try {
      const { viewer, accessToken } = await this.exchangeAndFetchViewer(
        code,
        config,
      );
      const session = await this.issueAnilistSession(
        model,
        viewer,
        accessToken,
      );
      const fragment = new URLSearchParams({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        userId: session.user.id,
      });
      return `${destination}#${fragment.toString()}`;
    } catch (err) {
      const shortCode =
        err instanceof BadRequestException
          ? 'auth_failed'
          : err instanceof BadGatewayException
            ? 'exchange_failed'
            : 'internal_error';
      return `${destination}#error=${shortCode}`;
    }
  }

  /**
   * Find-or-create the AniList user and mint the standard token pair —
   * the single session path shared by the POST and GET callbacks.
   */
  private async issueAnilistSession(
    model: Model<UserDocument>,
    viewer: AnilistViewer,
    accessToken: string,
  ): Promise<AuthResponse> {
    let user = await model.findOne({ 'anilist.userId': viewer.id }).exec();
    if (!user) {
      // REGISTRATION — the web's exact derivation: username from the
      // AniList name (lowercased, non-alphanumerics stripped), the
      // AniList id appended when that username is taken; synthetic
      // email; sentinel password (no password login, SEC-07); avatar
      // copied from AniList.
      let username = viewer.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const taken = await model.findOne({ username }).exec();
      if (taken) {
        username = `${username}${viewer.id}`;
      }
      user = await model.create({
        username,
        displayName: viewer.name,
        email: `anilist_${viewer.id}@kaikansen.io`,
        passwordHash: OAUTH_PASSWORD_SENTINEL,
        avatarUrl: viewer.avatar?.large ?? null,
        anilist: {
          accessToken,
          userId: viewer.id,
          username: viewer.name,
          syncedAt: new Date(),
        },
      });
    } else {
      // LOGIN — refresh the stored AniList token + sync stamp.
      if (user.anilist) {
        user.anilist.accessToken = accessToken;
        user.anilist.syncedAt = new Date();
      } else {
        user.anilist = {
          accessToken,
          userId: viewer.id,
          username: viewer.name,
          syncedAt: new Date(),
        };
      }
      await user.save();
    }

    const tokens = await this.issueSession(model, user);
    return { ...tokens, user: this.toProfile(user) };
  }

  /** POST /auth/anilist/link — attach AniList to the caller's account. */
  async anilistLink(
    userId: string,
    dto: AnilistLinkRequest,
  ): Promise<AnilistLinkResponse> {
    const model = this.requireModel();
    const config = this.requireAnilistConfig();
    const { viewer, accessToken } = await this.exchangeAndFetchViewer(
      dto?.code,
      config,
    );

    const holder = await model.findOne({ 'anilist.userId': viewer.id }).exec();
    if (holder && holder._id.toString() !== userId) {
      throw new ConflictException(
        'This AniList account is already linked to a different Kaikansen account',
      );
    }

    // The web's link write, verbatim: a $set of the whole sub-document.
    const user = await model
      .findByIdAndUpdate(
        userId,
        {
          $set: {
            anilist: {
              accessToken,
              userId: viewer.id,
              username: viewer.name,
              syncedAt: new Date(),
            },
          },
        },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return {
      linked: true,
      anilist: { userId: viewer.id, username: viewer.name },
    };
  }
}

/** The `received` word zod v4 puts in its invalid-type messages. */
function zodReceived(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * The web's profile-edit schema (app/api/users/me/route.ts), ported
 * check for check:
 *   displayName: string, 1–50 chars, optional
 *   bio:         string, ≤200 chars, optional
 *   avatarUrl:   string holding a valid URL, optional AND nullable
 * The web answers 400 with the FIRST zod issue's message; zod
 * evaluates fields in shape order (displayName, bio, avatarUrl), so
 * the checks run in that order here and the first failure throws —
 * before anything is written, so a bad field can never leave a
 * partial update behind. Message texts are zod v4's defaults,
 * verified against the web's zod (^4.3.6). Unknown fields are
 * ignored (zod strips them), and a field explicitly sent as
 * undefined counts as omitted, exactly as it parses there.
 *
 * Returns the $set-ready update: only the provided fields.
 */
function parseProfileUpdate(dto: UpdateProfileRequest): {
  displayName?: string;
  bio?: string;
  avatarUrl?: string | null;
  isPublic?: boolean;
} {
  const body: unknown = dto;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException(
      `Invalid input: expected object, received ${zodReceived(body)}`,
    );
  }
  const raw = body as Record<string, unknown>;
  const updates: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string | null;
    isPublic?: boolean;
  } = {};

  if (raw.displayName !== undefined) {
    const value = raw.displayName;
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `Invalid input: expected string, received ${zodReceived(value)}`,
      );
    }
    if (value.length < 1) {
      throw new BadRequestException(
        'Too small: expected string to have >=1 characters',
      );
    }
    if (value.length > 50) {
      throw new BadRequestException(
        'Too big: expected string to have <=50 characters',
      );
    }
    updates.displayName = value;
  }

  if (raw.bio !== undefined) {
    const value = raw.bio;
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `Invalid input: expected string, received ${zodReceived(value)}`,
      );
    }
    if (value.length > 200) {
      throw new BadRequestException(
        'Too big: expected string to have <=200 characters',
      );
    }
    updates.bio = value;
  }

  if (raw.avatarUrl !== undefined) {
    const value = raw.avatarUrl;
    if (value !== null) {
      if (typeof value !== 'string') {
        throw new BadRequestException(
          `Invalid input: expected string, received ${zodReceived(value)}`,
        );
      }
      try {
        // zod v4's .url() delegates to the WHATWG URL parser — the
        // same check, so the same strings pass and fail.
        new URL(value);
      } catch {
        throw new BadRequestException('Invalid URL');
      }
    }
    updates.avatarUrl = value as string | null;
  }

  // isPublic is NOT part of the web's edit schema (the web has no
  // toggle UI) — it is accepted additively for the app's Edit
  // Profile design (§6.28), whose Public-profile switch needs a
  // writable field. The field and its effect already exist on both
  // stacks: people search only returns public profiles. The check
  // runs AFTER avatarUrl so the web fields keep their first-issue
  // order; the message follows the same zod v4 wording pattern.
  if (raw.isPublic !== undefined) {
    const value = raw.isPublic;
    if (typeof value !== 'boolean') {
      throw new BadRequestException(
        `Invalid input: expected boolean, received ${zodReceived(value)}`,
      );
    }
    updates.isPublic = value;
  }

  return updates;
}
