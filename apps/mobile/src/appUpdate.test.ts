import { describe, expect, it } from '@jest/globals';
import type { AppVersionResponse } from '@kaikansen/contracts';
import {
  UPDATE_SNOOZE_MS,
  isSnoozed,
  parseUpdateSnooze,
  shouldShowUpdatePrompt,
  updateReducer,
  updateVerdict,
  type UpdateState,
} from './appUpdate';

const RELEASE: AppVersionResponse = {
  latestVersion: '1.1.0',
  latestVersionCode: 3,
  apkUrl: 'https://example.com/kaikansen.apk',
  notes: ['Weekly leaderboard'],
  minSupportedVersionCode: 2,
};

const IDLE: UpdateState = { phase: 'idle' };

describe('updateVerdict', () => {
  it('is current when installed equals or exceeds the latest code', () => {
    expect(updateVerdict(3, RELEASE)).toBe('current');
    expect(updateVerdict(4, RELEASE)).toBe('current');
  });

  it('is available when behind latest but at or above the floor', () => {
    expect(updateVerdict(2, RELEASE)).toBe('available');
  });

  it('is required below the supported floor — even if it were also behind latest', () => {
    expect(updateVerdict(1, RELEASE)).toBe('required');
    expect(
      updateVerdict(1, { latestVersionCode: 1, minSupportedVersionCode: 2 }),
    ).toBe('required');
  });
});

describe('snooze', () => {
  const snooze = { versionCode: 3, until: 1_000 + UPDATE_SNOOZE_MS };

  it('silences the same release inside the 24h window', () => {
    expect(isSnoozed(snooze, RELEASE, 2, 2_000)).toBe(true);
  });

  it('expires with the window', () => {
    expect(isSnoozed(snooze, RELEASE, 2, snooze.until)).toBe(false);
    expect(isSnoozed(snooze, RELEASE, 2, snooze.until + 1)).toBe(false);
  });

  it('a newer release overrides the snooze immediately', () => {
    expect(
      isSnoozed(snooze, { ...RELEASE, latestVersionCode: 4 }, 2, 2_000),
    ).toBe(false);
  });

  it('never silences a required update', () => {
    expect(isSnoozed(snooze, RELEASE, 1, 2_000)).toBe(false);
  });

  it('parses only well-formed records', () => {
    expect(parseUpdateSnooze(JSON.stringify(snooze))).toEqual(snooze);
    expect(parseUpdateSnooze(null)).toBeNull();
    expect(parseUpdateSnooze('not json')).toBeNull();
    expect(parseUpdateSnooze('{"versionCode":"3"}')).toBeNull();
  });
});

describe('updateReducer', () => {
  const checked = (
    state: UpdateState,
    installedVersionCode: number,
    snooze: { versionCode: number; until: number } | null = null,
    release: AppVersionResponse = RELEASE,
  ) =>
    updateReducer(state, {
      type: 'CHECKED',
      release,
      installedVersionCode,
      snooze,
      now: 5_000,
    });

  it('check → current settles back to idle', () => {
    const checking = updateReducer(IDLE, { type: 'CHECK_STARTED' });
    expect(checking).toEqual({ phase: 'checking' });
    expect(checked(checking, 3)).toEqual(IDLE);
  });

  it('check → available offers the prompt', () => {
    const checking = updateReducer(IDLE, { type: 'CHECK_STARTED' });
    expect(checked(checking, 2)).toEqual({
      phase: 'available',
      release: RELEASE,
    });
  });

  it('check → required is its own state (the one non-dismissible variant)', () => {
    const checking = updateReducer(IDLE, { type: 'CHECK_STARTED' });
    expect(checked(checking, 1)).toEqual({
      phase: 'required',
      release: RELEASE,
    });
  });

  it('a snoozed available update settles to idle; required ignores the snooze', () => {
    const checking = updateReducer(IDLE, { type: 'CHECK_STARTED' });
    const snooze = { versionCode: 3, until: 5_000 + UPDATE_SNOOZE_MS };
    expect(checked(checking, 2, snooze)).toEqual(IDLE);
    expect(checked(checking, 1, snooze)).toEqual({
      phase: 'required',
      release: RELEASE,
    });
  });

  it('a failed check is a silent no-op', () => {
    const checking = updateReducer(IDLE, { type: 'CHECK_STARTED' });
    expect(updateReducer(checking, { type: 'CHECK_FAILED' })).toEqual(IDLE);
  });

  it('Update → downloading with REAL clamped progress → installing', () => {
    const available = checked(
      updateReducer(IDLE, { type: 'CHECK_STARTED' }),
      2,
    );
    const downloading = updateReducer(available, { type: 'UPDATE_PRESSED' });
    expect(downloading).toEqual({
      phase: 'downloading',
      release: RELEASE,
      progress: 0,
    });
    const half = updateReducer(downloading, { type: 'PROGRESS', fraction: 0.5 });
    expect(half).toEqual({
      phase: 'downloading',
      release: RELEASE,
      progress: 0.5,
    });
    // Fractions are clamped — the bar never invents bytes.
    expect(
      updateReducer(downloading, { type: 'PROGRESS', fraction: 1.7 }),
    ).toMatchObject({ progress: 1 });
    expect(updateReducer(half, { type: 'DOWNLOAD_DONE' })).toEqual({
      phase: 'installing',
      release: RELEASE,
    });
  });

  it('download and installer failures land in the error state', () => {
    const available = checked(
      updateReducer(IDLE, { type: 'CHECK_STARTED' }),
      2,
    );
    const downloading = updateReducer(available, { type: 'UPDATE_PRESSED' });
    expect(
      updateReducer(downloading, { type: 'FAILED', message: 'boom' }),
    ).toEqual({ phase: 'error', release: RELEASE, message: 'boom' });
    const installing = updateReducer(downloading, { type: 'DOWNLOAD_DONE' });
    expect(
      updateReducer(installing, { type: 'FAILED', message: 'no installer' }),
    ).toEqual({ phase: 'error', release: RELEASE, message: 'no installer' });
  });

  it('Later dismisses only the optional prompt', () => {
    const available = checked(
      updateReducer(IDLE, { type: 'CHECK_STARTED' }),
      2,
    );
    expect(updateReducer(available, { type: 'LATER_PRESSED' })).toEqual(IDLE);
    const required = checked(
      updateReducer(IDLE, { type: 'CHECK_STARTED' }),
      1,
    );
    expect(updateReducer(required, { type: 'LATER_PRESSED' })).toEqual(
      required,
    );
  });

  it('stray events never corrupt the machine', () => {
    expect(updateReducer(IDLE, { type: 'UPDATE_PRESSED' })).toEqual(IDLE);
    expect(updateReducer(IDLE, { type: 'PROGRESS', fraction: 0.3 })).toEqual(
      IDLE,
    );
  });
});

describe('prompt priority', () => {
  it('the offline takeover outranks the update prompt', () => {
    expect(shouldShowUpdatePrompt(true)).toBe(false);
    expect(shouldShowUpdatePrompt(false)).toBe(true);
  });
});
