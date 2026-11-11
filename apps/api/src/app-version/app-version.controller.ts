import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AppVersionResponse } from '@kaikansen/contracts';

/**
 * GET /app/version — the release facts behind the app's in-app
 * update prompt (release readiness, 2026-11-11).
 *
 * The values come from operator-edited environment config, read
 * per request so a release is a config change, never a code
 * change:
 * - APP_LATEST_VERSION      (default '1.0.1')
 * - APP_LATEST_VERSION_CODE (default 3; non-numeric/junk → default)
 * - APP_APK_URL             (default the rolling release asset)
 * - APP_RELEASE_NOTES       (default '' → no notes; lines split on
 *                            '\n', blank lines dropped)
 * - APP_MIN_SUPPORTED_CODE  (default 1; junk → default)
 *
 * The default apkUrl is the asset the Actions pipeline uploads to
 * the rolling `apk-latest` GitHub release: the workflow builds
 * `--output "$GITHUB_WORKSPACE/kaikansen.apk"` and runs
 * `gh release upload apk-latest kaikansen.apk --clobber`
 * (.github/workflows/android-build.yml), so the stable download
 * URL is .../releases/download/apk-latest/kaikansen.apk — the
 * asset name `kaikansen.apk` confirmed from the workflow, the
 * repo's own record of what the release carries.
 *
 * Unauthenticated by design: the check runs before any session
 * matters, and the payload is public release metadata. No database
 * involved — this answers in every boot posture, like /health.
 */
@ApiTags('app')
@Controller('app')
export class AppVersionController {
  constructor(private readonly config?: ConfigService) {}

  @Get('version')
  @ApiOkResponse({ description: 'Latest release facts for the update prompt.' })
  version(): AppVersionResponse {
    return {
      latestVersion: this.stringOr('APP_LATEST_VERSION', '1.0.1'),
      latestVersionCode: this.intOr('APP_LATEST_VERSION_CODE', 3),
      apkUrl: this.stringOr(
        'APP_APK_URL',
        'https://github.com/Xantonozar/kaikansen-app/releases/download/apk-latest/kaikansen.apk',
      ),
      notes: this.notes(),
      minSupportedVersionCode: this.intOr('APP_MIN_SUPPORTED_CODE', 1),
    };
  }

  private stringOr(key: string, fallback: string): string {
    const value = this.config?.get<string>(key) ?? process.env[key];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : fallback;
  }

  private intOr(key: string, fallback: number): number {
    const raw = this.config?.get<string>(key) ?? process.env[key];
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseInt(raw, 10)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private notes(): string[] {
    const raw =
      this.config?.get<string>('APP_RELEASE_NOTES') ??
      process.env.APP_RELEASE_NOTES;
    if (typeof raw !== 'string') return [];
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}
