import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
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
import { AccessTokenGuard } from './access-token.guard';
import { AuthService, type TokenPayload } from './auth.service';
import { AUTH_THROTTLE, SKIP_ACCOUNT_THROTTLE } from './auth-throttle';

/**
 * Slice 2 auth endpoints — a native-first port of the web's
 * /api/auth/* routes. Status codes follow the web (200s, 400, 401,
 * 409); error bodies use this API's ApiErrorResponse shape with the
 * web's messages. When the API is booted without MONGODB_URI the
 * service answers 503 on every endpoint (the guard on /auth/me still
 * rejects tokenless requests with 401 first — it needs no database).
 *
 * Every route is rate-limited (audit C1): ThrottlerGuard enforces
 * the two buckets from auth-throttle.ts — a per-IP bucket and a
 * per-email (targeted account) bucket, tightened per route with
 * @Throttle; routes whose bodies carry no email skip the account
 * bucket. Over the limit the guard answers 429 before the handler
 * (and before the Bearer guard) runs.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.register)
  @ApiOkResponse({ description: 'Registered; returns tokens + profile.' })
  register(@Body() body: RegisterRequest): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.login)
  @ApiOkResponse({ description: 'Logged in; returns tokens + profile.' })
  login(@Body() body: LoginRequest): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.refresh)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description: 'Refresh token (in the body) rotated into a fresh pair.',
  })
  refresh(@Body() body: RefreshRequest): Promise<AuthTokens> {
    return this.auth.refresh(body);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'Server-side logout: every tracked refresh family is revoked and the session generation bumped, so the caller’s refresh tokens die everywhere — not just on this device.',
  })
  logout(@Req() req: { user: TokenPayload }): Promise<LogoutResponse> {
    return this.auth.logout(req.user.userId);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.forgotPassword)
  @ApiOkResponse({
    description:
      'Starts a password reset. ALWAYS 200 with the same generic body, whether or not the account exists — a 6-digit code (15-minute expiry) is emailed only when a password account exists for the address. AniList-only accounts never receive a code. (New capability: the web has no password reset at all.)',
  })
  forgotPassword(
    @Body() body: ForgotPasswordRequest,
  ): Promise<ForgotPasswordResponse> {
    return this.auth.forgotPassword(body);
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.resetPassword)
  @ApiOkResponse({
    description:
      'Completes a password reset: verifies the emailed code (stored hashed; max 5 attempts; single-use), sets the new password, and revokes every refresh token issued before the reset. Any code failure answers the same generic 400.',
  })
  resetPassword(
    @Body() body: ResetPasswordRequest,
  ): Promise<ResetPasswordResponse> {
    return this.auth.resetPassword(body);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'The caller’s own profile, with the listening-stats aggregates attached (stats).',
  })
  me(@Req() req: { user: TokenPayload }): Promise<UserProfile> {
    return this.auth.me(req.user.userId);
  }

  @Patch('me')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'Edit the caller’s own profile (the web’s PATCH /api/users/me): partial update of displayName / bio / avatarUrl under the web’s validation; returns the updated profile in the GET /auth/me shape.',
  })
  updateMe(
    @Req() req: { user: TokenPayload },
    @Body() body: UpdateProfileRequest,
  ): Promise<UserProfile> {
    return this.auth.updateProfile(req.user.userId, body);
  }

  @Get('anilist/url')
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'The AniList authorize URL to open in a browser / web view. Optional ?state=login|link is forwarded to AniList and echoed back to the callback. 503 when AniList is not configured.',
  })
  anilistUrl(@Query('state') state?: string): Promise<AnilistUrlResponse> {
    return this.auth.anilistUrl(state);
  }

  @Post('anilist/callback')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE.anilistCallback)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'Exchanges the AniList code, finds-or-creates the user, returns tokens + profile (same shape as login).',
  })
  anilistCallback(
    @Body() body: AnilistCallbackRequest,
  ): Promise<AuthResponse> {
    return this.auth.anilistCallback(body);
  }

  @Get('anilist/callback')
  @Throttle(AUTH_THROTTLE.anilistCallback)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'Server-side OAuth landing (AniList client 56177’s registered redirect): 302 to ANILIST_POST_LOGIN_REDIRECT with the session in the URL fragment, or #error=<code> on failure. With state=link it exchanges nothing and bounces #code=…&state=link for the authenticated app to POST to /auth/anilist/link. 503 JSON when unconfigured.',
  })
  async anilistCallbackRedirect(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: { redirect: (status: number, url: string) => void },
  ): Promise<void> {
    const url = await this.auth.anilistCallbackRedirectUrl(code, state);
    res.redirect(302, url);
  }

  @Post('anilist/link')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @Throttle(AUTH_THROTTLE.anilistLink)
  @SkipThrottle(SKIP_ACCOUNT_THROTTLE)
  @ApiOkResponse({
    description:
      'Links the AniList account from the code to the caller’s account. 409 if that AniList account belongs to another user.',
  })
  anilistLink(
    @Req() req: { user: TokenPayload },
    @Body() body: AnilistLinkRequest,
  ): Promise<AnilistLinkResponse> {
    return this.auth.anilistLink(req.user.userId, body);
  }
}
