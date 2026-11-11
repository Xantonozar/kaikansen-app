import { AppVersionController } from './app-version.controller';

/**
 * The /app/version payload (release readiness, 2026-11-11):
 * env-backed config with sane defaults — a release is an env
 * change, never a code change. Junk config must never reach the
 * app: unparsable numbers fall back to the defaults.
 */
describe('AppVersionController', () => {
  const DEFAULTS = {
    latestVersion: '1.0.1',
    latestVersionCode: 3,
    apkUrl:
      'https://github.com/Xantonozar/kaikansen-app/releases/download/apk-latest/kaikansen.apk',
    notes: [],
    minSupportedVersionCode: 1,
  };

  it('serves the defaults with no config at all', () => {
    expect(new AppVersionController().version()).toEqual(DEFAULTS);
  });

  it('serves env-backed values when the operator sets them', () => {
    const config = {
      get: (key: string) =>
        ({
          APP_LATEST_VERSION: '1.2.0',
          APP_LATEST_VERSION_CODE: '7',
          APP_APK_URL: 'https://example.com/app.apk',
          APP_RELEASE_NOTES: 'New ranks\n\nWeekly board\n',
          APP_MIN_SUPPORTED_CODE: '3',
        })[key],
    } as never;
    expect(new AppVersionController(config).version()).toEqual({
      latestVersion: '1.2.0',
      latestVersionCode: 7,
      apkUrl: 'https://example.com/app.apk',
      notes: ['New ranks', 'Weekly board'],
      minSupportedVersionCode: 3,
    });
  });

  it('falls back to the defaults on junk numbers and blank strings', () => {
    const config = {
      get: (key: string) =>
        ({
          APP_LATEST_VERSION: '   ',
          APP_LATEST_VERSION_CODE: 'soon',
          APP_MIN_SUPPORTED_CODE: '-4',
        })[key],
    } as never;
    const payload = new AppVersionController(config).version();
    expect(payload.latestVersion).toBe('1.0.1');
    expect(payload.latestVersionCode).toBe(3);
    expect(payload.minSupportedVersionCode).toBe(1);
  });
});
