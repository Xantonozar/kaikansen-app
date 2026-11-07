import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type {
  AuthResponse,
  AuthTokens,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { User, type UserDocument } from './user.schema';

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
}

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
 *     re-issues only an access token). Rotation here is stateless —
 *     there is no server-side session store, no reuse detection and no
 *     revocation; a stolen refresh token still works until it is
 *     presented or expires. Session policy beyond this is OPEN item
 *     O-10 (specs/DECISIONS.md) — undecided, not silently settled here.
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

  private signPair(claims: Omit<TokenPayload, 'tokenType'>): AuthTokens {
    const accessToken = jwt.sign(
      { ...claims, tokenType: 'access' },
      this.secret('access'),
      { expiresIn: ACCESS_TTL },
    );
    const refreshToken = jwt.sign(
      { ...claims, tokenType: 'refresh' },
      this.secret('refresh'),
      // A random jwtid per refresh token: without it, a login and a
      // refresh inside the same second would mint byte-identical tokens
      // (same claims, same iat/exp) and "rotation" would be a no-op.
      // The id is not stored — verification stays stateless.
      { expiresIn: REFRESH_TTL, jwtid: randomUUID() },
    );
    return { accessToken, refreshToken };
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

    const tokens = this.signPair({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
    });
    return { ...tokens, user: this.toProfile(user) };
  }

  /** POST /auth/login — the web's app/api/auth/login/route.ts. */
  async login(dto: LoginRequest): Promise<AuthResponse> {
    const model = this.requireModel();
    const { email, password } = dto ?? ({} as LoginRequest);
    if (!email || !password) {
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

    const tokens = this.signPair({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
    });
    return { ...tokens, user: this.toProfile(user) };
  }

  /** POST /auth/refresh — body-carried refresh token, rotated pair out. */
  async refresh(dto: RefreshRequest): Promise<AuthTokens> {
    this.requireModel();
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
    // ROTATE (deviation 2, above): mint a whole new pair from the
    // verified claims. Stateless — the old refresh token is not tracked
    // or revoked; see the class comment and OPEN item O-10.
    return this.signPair({
      userId: payload.userId,
      username: payload.username,
      email: payload.email,
    });
  }

  /** GET /auth/me — profile for the bearer token's user. */
  async me(userId: string): Promise<UserProfile> {
    const model = this.requireModel();
    const user = await model.findById(userId).exec();
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return this.toProfile(user);
  }
}
