import { describe, expect, it } from '@jest/globals';
import type { ThemeDetail } from '@kaikansen/contracts';
import {
  LOCK_SCREEN_OPTIONS,
  lockScreenMetadataForDetail,
  lockScreenMetadataForLocal,
  lockScreenMetadataKey,
  shouldActivateLockScreen,
} from './lockScreen';

/**
 * Lock-screen / media-notification decisions (owner report,
 * 2026-11-18): when the Android media session registers, what
 * it shows, and which controls it offers. Native behaviour
 * itself is the owner's device tap-test territory.
 */

const detail = {
  songTitle: 'Kakumei Douchuu',
  artistName: 'AiNA THE END',
  allArtists: ['AiNA THE END'],
  animeTitle: 'DAN DA DAN Season 2',
  animeCoverImage: 'https://img/full.jpg',
  animeCoverImageSmall: 'https://img/small.jpg',
} as unknown as ThemeDetail;

describe('shouldActivateLockScreen', () => {
  it('activates for an active session on the audio engine', () => {
    expect(
      shouldActivateLockScreen({
        active: true,
        engineKind: 'audio',
        unavailable: false,
      }),
    ).toBe(true);
  });

  it('stays off for the video engine (Watch + hidden-video fallback)', () => {
    expect(
      shouldActivateLockScreen({
        active: true,
        engineKind: 'video',
        unavailable: false,
      }),
    ).toBe(false);
  });

  it('stays off when the session is inactive or the chain failed', () => {
    expect(
      shouldActivateLockScreen({
        active: false,
        engineKind: 'audio',
        unavailable: false,
      }),
    ).toBe(false);
    expect(
      shouldActivateLockScreen({
        active: true,
        engineKind: 'audio',
        unavailable: true,
      }),
    ).toBe(false);
  });
});

describe('lock screen metadata', () => {
  it('maps a detail: joined artists, anime as album, FULL cover', () => {
    expect(lockScreenMetadataForDetail(detail)).toEqual({
      title: 'Kakumei Douchuu',
      artist: 'AiNA THE END',
      albumTitle: 'DAN DA DAN Season 2',
      artworkUrl: 'https://img/full.jpg',
    });
  });

  it('falls back to artistName and the small cover', () => {
    const sparse = {
      ...detail,
      allArtists: [],
      animeCoverImage: null,
    } as unknown as ThemeDetail;
    const meta = lockScreenMetadataForDetail(sparse);
    expect(meta.artist).toBe('AiNA THE END');
    expect(meta.artworkUrl).toBe('https://img/small.jpg');
  });

  it('maps a download snapshot, artist falling back to the anime', () => {
    expect(
      lockScreenMetadataForLocal({
        songTitle: 'HUGs',
        artistName: null,
        animeTitle: 'Gachiakuta',
        coverImage: null,
      }),
    ).toEqual({
      title: 'HUGs',
      artist: 'Gachiakuta',
      albumTitle: 'Gachiakuta',
      artworkUrl: undefined,
    });
  });

  it('keys metadata stably for change detection', () => {
    const a = lockScreenMetadataForDetail(detail);
    expect(lockScreenMetadataKey(a)).toBe(lockScreenMetadataKey({ ...a }));
    expect(
      lockScreenMetadataKey({ ...a, title: 'Other' }),
    ).not.toBe(lockScreenMetadataKey(a));
    expect(lockScreenMetadataKey(null)).toBeNull();
  });
});

describe('LOCK_SCREEN_OPTIONS', () => {
  it('offers seek controls and no track-skip (single-player API)', () => {
    expect(LOCK_SCREEN_OPTIONS.showSeekForward).toBe(true);
    expect(LOCK_SCREEN_OPTIONS.showSeekBackward).toBe(true);
    expect(LOCK_SCREEN_OPTIONS.showNextTrack).toBe(false);
    expect(LOCK_SCREEN_OPTIONS.showPreviousTrack).toBe(false);
  });
});
