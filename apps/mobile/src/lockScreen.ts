import type {
  AudioLockScreenOptions,
  AudioMetadata,
} from 'expo-audio';
import type { ThemeDetail } from '@kaikansen/contracts';

/**
 * Android media notification / lock-screen controls for Listen
 * playback (owner report, 2026-11-18: with a theme playing, the
 * notification shade said "No songs" and the lock screen had no
 * Kaikansen controls, unlike other music apps).
 *
 * The bridge is expo-audio's OWN media session — no second
 * engine and no extra library: the playback engine's live audio
 * player (src/usePlayback.ts) calls setActiveForLockScreen /
 * updateLockScreenMetadata / clearLockScreenControls, and
 * Android's MediaSession then drives THAT player directly
 * (play/pause and ±seek land on the player, whose status events
 * are already the engine's single source of truth — the mini
 * player and detail heroes follow automatically). The app's
 * audio mode already satisfies the native preconditions
 * (interruptionMode 'doNotMix' + shouldPlayInBackground, and
 * the config plugin's enableBackgroundPlayback service
 * declaration is in app.json).
 *
 * What the single-player API cannot do: next/previous buttons.
 * expo-audio only offers track-skip commands for its
 * AudioPlaylist player (the single AudioPlayer reports
 * supportsNextTrack=false and never surfaces the buttons), so
 * the options below ask for seek ±10s instead — queue skips
 * stay on the mini player / player route, whose next()/prev()
 * re-point this same session (and the metadata update below
 * follows the new track). Migrating the queue into
 * AudioPlaylist or react-native-track-player would change the
 * locked playback architecture and is NOT done here.
 *
 * Watch mode is not covered: expo-video exposes no media
 * session API, so a Watch session registers nothing (the
 * hidden-video listen fallback plays through the video player
 * too and is likewise uncovered). When a Watch claim degrades
 * to the listen chain's AUDIO (W2), the candidate plays on the
 * audio player and the controls below DO engage — the rule is
 * "the audio player is the one playing", not the claim's mode.
 */

/** The metadata payload shape (expo-audio's AudioMetadata). */
export type LockScreenMetadata = AudioMetadata;

/** Controls the notification offers: play/pause (always) +
    seek back/forward 10s. No next/previous — see the header. */
export const LOCK_SCREEN_OPTIONS: AudioLockScreenOptions = {
  showSeekForward: true,
  showSeekBackward: true,
  showNextTrack: false,
  showPreviousTrack: false,
  seekForwardIntervalSeconds: 10,
  seekBackwardIntervalSeconds: 10,
};

/** Whether the media session should be registered right now:
    the session is active, the live candidate plays on the
    AUDIO engine, and a source actually resolved (an exhausted
    chain — `unavailable` — must not leave a dead notification
    behind). */
export function shouldActivateLockScreen(input: {
  active: boolean;
  engineKind: 'audio' | 'video';
  unavailable: boolean;
}): boolean {
  return input.active && input.engineKind === 'audio' && !input.unavailable;
}

/** Metadata from the catalogue detail in hand. The artwork is
    the FULL cover (the notification is a large surface — the
    mini player's small-variant rule does not apply here). */
export function lockScreenMetadataForDetail(
  detail: ThemeDetail,
): AudioMetadata {
  return {
    title: detail.songTitle,
    artist:
      detail.allArtists.length > 0
        ? detail.allArtists.join(' / ')
        : (detail.artistName ?? undefined),
    albumTitle: detail.animeTitle,
    artworkUrl:
      detail.animeCoverImage ?? detail.animeCoverImageSmall ?? undefined,
  };
}

/** Metadata from a download's display snapshot (fully-offline
    opens have no detail to read). Structural subset of
    DownloadRecord (src/downloads.ts). */
export function lockScreenMetadataForLocal(local: {
  songTitle: string;
  artistName: string | null;
  animeTitle: string;
  coverImage: string | null;
}): AudioMetadata {
  return {
    title: local.songTitle,
    artist: local.artistName ?? local.animeTitle,
    albumTitle: local.animeTitle,
    artworkUrl: local.coverImage ?? undefined,
  };
}

/** Stable identity for a metadata payload — the engine compares
    keys so a re-render with the same track doesn't re-push the
    same metadata to the native session. */
export function lockScreenMetadataKey(
  metadata: AudioMetadata | null,
): string | null {
  if (!metadata) return null;
  return [
    metadata.title ?? '',
    metadata.artist ?? '',
    metadata.albumTitle ?? '',
    metadata.artworkUrl ?? '',
  ].join('|');
}
