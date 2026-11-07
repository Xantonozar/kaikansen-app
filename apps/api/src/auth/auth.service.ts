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
import { randomUUID } from 'crypto';
import type {
  AnilistCallbackRequest,
  AnilistLinkRequest,
  AnilistLinkResponse,
  AnilistUrlResponse,
  AuthResponse,
  AuthTokens,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import {
  AnilistClient,
  type AnilistConfig,
  type AnilistViewer,
} from './anilist.client';
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
    @Optional()
    private readonly anilist?: AnilistClient,
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

    const tokens = this.signPair({
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
    });
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
