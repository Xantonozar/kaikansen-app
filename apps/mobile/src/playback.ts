import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
} from '@kaikansen/contracts';

/**
 * Playback source resolution (Slice M1), mirroring the web player
 * (kaisen-src `app/components/theme/VideoPlayer.tsx` +
 * `app/theme/[slug]/ThemePageClient.tsx`): the SELECTED ENTRY is the
 * source of truth.
 *
 * - watch — the entry's video. The web hands the player the entry's
 *   `videoSources` sorted by resolution descending (its quality menu),
 *   so the single-source mobile player takes the highest resolution.
 *   Falls back to the entry's stored `videoUrl`, then the theme-level
 *   `videoUrl`.
 * - listen — the entry's `audioUrl`, falling back to the theme-level
 *   `audioUrl`. (The web disables its listen toggle when the entry has
 *   no audioUrl; the theme-level fallback is what the catalogue data
 *   itself provides — the theme-level URL is the primary entry's link.)
 *   When NO stored audio exists, the derived .ogg twin of the video
 *   file steps in (see deriveAudioUrl): most of the catalogue stores
 *   `audioUrl: null`, and without the derivation listen mode — and
 *   audio downloads, which resolve through this same module — would
 *   have nothing to play for those themes. The API derives the same
 *   way into its payloads; the rule is mirrored here so resolution
 *   stays whole even against a payload that predates it.
 */
export function resolvePlaybackUrl(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
  mode: PlaybackMode,
): string | null {
  if (mode === 'listen') {
    return storedListenUrl(detail, entry) ?? derivedListenUrl(detail, entry);
  }
  if (!entry) {
    return detail.videoUrl;
  }
  const best = [...entry.videoSources].sort(
    (a, b) => b.resolution - a.resolution,
  )[0];
  return best?.url ?? entry.videoUrl ?? detail.videoUrl;
}

/* ------------------------------------------------------------------ */
/* Derived .ogg audio (mirror of the API's themes/audio-url.ts)        */
/* ------------------------------------------------------------------ */

const AT_VIDEO_PREFIX = 'https://v.animethemes.moe/';
const AT_AUDIO_PREFIX = 'https://a.animethemes.moe/';
const AT_VIDEO_SUFFIX = '.webm';

/**
 * The .ogg audio twin of an AnimeThemes video URL —
 * `https://v.animethemes.moe/<File>.webm` →
 * `https://a.animethemes.moe/<File>.ogg` — or null when the video URL
 * does not follow that one verified pattern (any other host/shape).
 * AnimeThemes hosts the twin for every theme video; the catalogue
 * simply never stored the link.
 */
export function deriveAudioUrl(videoUrl: string | null): string | null {
  if (videoUrl === null) return null;
  if (!videoUrl.startsWith(AT_VIDEO_PREFIX)) return null;
  if (!videoUrl.endsWith(AT_VIDEO_SUFFIX)) return null;
  const file = videoUrl.slice(
    AT_VIDEO_PREFIX.length,
    videoUrl.length - AT_VIDEO_SUFFIX.length,
  );
  if (file.length === 0) return null;
  return `${AT_AUDIO_PREFIX}${file}.ogg`;
}

/** Stored audio only: the entry's audioUrl, then the theme-level one. */
function storedListenUrl(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): string | null {
  if (!entry) return detail.audioUrl;
  return entry.audioUrl ?? detail.audioUrl;
}

/**
 * Derived audio only: the .ogg twin of the entry's own video file,
 * then of the theme-level video file.
 */
function derivedListenUrl(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): string | null {
  if (!entry) return deriveAudioUrl(detail.videoUrl);
  return deriveAudioUrl(entry.videoUrl) ?? deriveAudioUrl(detail.videoUrl);
}

/**
 * The listen-mode fallback chain for the player, in order: stored
 * audio, the derived .ogg, then — only when an audio source exists —
 * the watch video file itself (the player keeps the surface hidden,
 * so it plays as audio). Empty when the theme has no audio source at
 * all: listen then reports unavailable, exactly as before. Downloads
 * do NOT use this chain — an audio download resolves through
 * resolvePlaybackUrl and never substitutes the video file.
 */
export function resolveListenCandidates(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): string[] {
  const audio = [
    storedListenUrl(detail, entry),
    derivedListenUrl(detail, entry),
  ].filter((url, i, all): url is string => {
    return isPlausibleUrl(url) && all.indexOf(url) === i;
  });
  if (audio.length === 0) return [];
  const watch = resolvePlaybackUrl(detail, entry, 'watch');
  return isPlausibleUrl(watch) && !audio.includes(watch)
    ? [...audio, watch]
    : audio;
}

/** Whether listen mode has anything to play for this entry. */
export function entryHasAudio(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): boolean {
  return resolvePlaybackUrl(detail, entry, 'listen') !== null;
}

/* ------------------------------------------------------------------ */
/* Quiz question audio (owner ruling: questions are audio-only)       */
/* ------------------------------------------------------------------ */

const AUDIO_FILE_EXTENSIONS = [
  '.ogg',
  '.mp3',
  '.m4a',
  '.aac',
  '.opus',
  '.flac',
  '.wav',
];

/**
 * The ONE audio source a quiz question may play, picked from a
 * multiplayer round's flat candidate list. The API builds that list
 * as [video, audio, ...entry video sources] (quiz-rooms
 * buildMediaCandidates; the contract documents the same order), but
 * the list itself is unlabelled, so the audio entry is recognised,
 * in order:
 *  1. the derived .ogg twin of the round's videoUrl, when listed
 *     (the catalogue's normal case — stored audioUrl is null and
 *     the API resolved the same derivation);
 *  2. any non-video candidate whose path ends in an audio extension
 *     (a stored audioUrl on another host);
 *  3. the candidate in the API's audio slot — index 1 when index 0
 *     is the video (a stored audioUrl that itself carries a
 *     video-file extension: the sync stores the lowest-resolution
 *     entry link as audioUrl when it stores one at all).
 * Null when no candidate can be identified as audio: the round then
 * reports no playable media instead of ever surfacing the video.
 */
export function quizAudioCandidate(
  videoUrl: string | null,
  candidates: (string | null)[],
): string | null {
  const plausible = candidates.filter(isPlausibleUrl);
  if (plausible.length === 0) return null;
  const derived = deriveAudioUrl(videoUrl);
  if (derived && plausible.includes(derived)) return derived;
  const byExtension = plausible.find((url) => {
    if (url === videoUrl) return false;
    const path = url.split(/[?#]/)[0].toLowerCase();
    return AUDIO_FILE_EXTENSIONS.some((ext) => path.endsWith(ext));
  });
  if (byExtension) return byExtension;
  if (videoUrl && plausible[0] === videoUrl && plausible.length > 1) {
    return plausible[1];
  }
  return null;
}

/**
 * Whether a URL is worth handing to the player at all. Fixture themes
 * carry real https URLs (v.animethemes.moe) so fixture playback is
 * genuinely attempted; anything else (empty, relative, junk) is
 * treated as "no source" instead of a player error.
 */
export function isPlausibleUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

/** "1:23" / "0:07" — player time labels. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}
