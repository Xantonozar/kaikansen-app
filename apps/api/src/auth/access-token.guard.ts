import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Bearer access-token guard for GET /auth/me and future protected
 * routes: `Authorization: Bearer <access token>`, verified by
 * AuthService (signature + token type + lifetime). The verified claims
 * land on `request.user`. Anything missing or invalid is a 401 — the
 * web's session helpers answer the same way for absent sessions.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const payload = this.auth.verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) {
      throw new UnauthorizedException();
    }
    request.user = payload;
    return true;
  }
}
