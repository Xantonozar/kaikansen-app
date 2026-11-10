import { describe, expect, it } from '@jest/globals';
import {
  connectivityFromSample,
  savedThemesLabel,
  shouldShowOfflineScreen,
  type ConnectivityStatus,
} from './offline';

describe('connectivityFromSample', () => {
  it('null/undefined samples are never definitive — unknown stays unknown (no first-paint flash)', () => {
    expect(connectivityFromSample('unknown', null)).toBe('unknown');
    expect(connectivityFromSample('unknown', undefined)).toBe('unknown');
  });

  it('isConnected === false is the only offline signal', () => {
    expect(connectivityFromSample('unknown', false)).toBe('offline');
    expect(connectivityFromSample('online', false)).toBe('offline');
  });

  it('isConnected === true is online', () => {
    expect(connectivityFromSample('unknown', true)).toBe('online');
    expect(connectivityFromSample('offline', true)).toBe('online');
  });

  it('a null blip never erases a known state', () => {
    expect(connectivityFromSample('offline', null)).toBe('offline');
    expect(connectivityFromSample('online', null)).toBe('online');
  });
});

describe('shouldShowOfflineScreen', () => {
  const cold = { pathname: '/', surfaceCanServe: false };

  it('definitive offline + cold surface → takeover', () => {
    expect(
      shouldShowOfflineScreen({ connectivity: 'offline', ...cold }),
    ).toBe(true);
  });

  it('unknown connectivity never shows (no flash at first paint)', () => {
    expect(
      shouldShowOfflineScreen({ connectivity: 'unknown', ...cold }),
    ).toBe(false);
  });

  it('online never shows — and coming back online dismisses a shown screen', () => {
    // The gate renders the takeover iff this returns true, so the
    // offline → online transition flips the render off: dismissal
    // on reconnect is this same decision re-evaluated.
    let status: ConnectivityStatus = 'unknown';
    status = connectivityFromSample(status, false);
    expect(
      shouldShowOfflineScreen({ connectivity: status, ...cold }),
    ).toBe(true);
    status = connectivityFromSample(status, true);
    expect(
      shouldShowOfflineScreen({ connectivity: status, ...cold }),
    ).toBe(false);
  });

  it('a surface that can serve (cache-served data, local surface, playback) is never blocked', () => {
    expect(
      shouldShowOfflineScreen({
        connectivity: 'offline',
        pathname: '/',
        surfaceCanServe: true,
      }),
    ).toBe(false);
    expect(
      shouldShowOfflineScreen({
        connectivity: 'offline',
        pathname: '/theme/some-slug',
        surfaceCanServe: true,
      }),
    ).toBe(false);
  });

  it('exempt routes never show: pre-auth surfaces and the Downloads destination', () => {
    for (const pathname of [
      '/login',
      '/register',
      '/forgot-password',
      '/anilist-handoff',
      '/downloads',
    ]) {
      expect(
        shouldShowOfflineScreen({
          connectivity: 'offline',
          pathname,
          surfaceCanServe: false,
        }),
      ).toBe(false);
    }
  });
});

describe('savedThemesLabel', () => {
  it('0 reads honestly', () => {
    expect(savedThemesLabel(0)).toBe('No themes saved on this device yet');
  });

  it('1 is singular', () => {
    expect(savedThemesLabel(1)).toBe('1 theme saved on this device');
  });

  it('plural counts read as the design draws them', () => {
    expect(savedThemesLabel(2)).toBe('2 themes saved on this device');
    expect(savedThemesLabel(24)).toBe('24 themes saved on this device');
  });
});
