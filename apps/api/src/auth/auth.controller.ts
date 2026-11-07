import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  AuthResponse,
  AuthTokens,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from './access-token.guard';
import { AuthService, type TokenPayload } from './auth.service';

/**
 * Slice 2 auth endpoints — a native-first port of the web's
 * /api/auth/* routes. Status codes follow the web (200s, 400, 401,
 * 409); error bodies use this API's ApiErrorResponse shape with the
 * web's messages. When the API is booted without MONGODB_URI the
 * service answers 503 on every endpoint (the guard on /auth/me still
 * rejects tokenless requests with 401 first — it needs no database).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Registered; returns tokens + profile.' })
  register(@Body() body: RegisterRequest): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Logged in; returns tokens + profile.' })
  login(@Body() body: LoginRequest): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({
    description: 'Refresh token (in the body) rotated into a fresh pair.',
  })
  refresh(@Body() body: RefreshRequest): Promise<AuthTokens> {
    return this.auth.refresh(body);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({ description: 'The caller’s own profile.' })
  me(@Req() req: { user: TokenPayload }): Promise<UserProfile> {
    return this.auth.me(req.user.userId);
  }
}
