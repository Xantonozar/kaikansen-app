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

/**
 * The watch-mode fallback chain for the player, in order: the
 * entry's video sources by resolution descending, the entry's
 * stored `videoUrl`, then the theme-level `videoUrl` — plausible
 * URLs only, de-duplicated. Watch used to hand the player exactly
 * ONE source (the highest resolution): when that single file
 * failed on a device — an encode its decoder rejects, a CDN
 * refusal — playback died on a black surface with no second
 * chance. The chain gives the player the lower-resolution encodes
 * of the same entry to fall back to, the same way listen mode
 * already steps through its candidates. Downloads do NOT use this
 * chain — a video download resolves through resolvePlaybackUrl
 * and takes the single best source.
 */
export function resolveWatchCandidates(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): string[] {
  const raw: (string | null)[] = entry
    ? [
        ...[...entry.videoSources]
          .sort((a, b) => b.resolution - a.resolution)
          .map((source) => source.url),
        entry.videoUrl,
        detail.videoUrl,
      ]
    : [detail.videoUrl];
  return raw.filter((url, i, all): url is string => {
    return isPlausibleUrl(url) && all.indexOf(url) === i;
  });
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
 * The audio sources a quiz question may play, IN ORDER, picked
 * from a multiplayer round's flat candidate list (owner doctrine,
 * 2026-11-10: the .ogg first; the video file itself, played
 * audio-only, is the last resort — a question may only report no
 * playable media after BOTH have failed). The API builds the list
 * in playback order as [resolved audio, video, ...entry video
 * sources] (quiz-rooms buildMediaCandidates; the contract
 * documents the same order), but the list itself is unlabelled,
 * so the order is re-derived defensively:
 *  1. the derived .ogg twin of the round's videoUrl, when listed
 *     (the catalogue's normal case — stored audioUrl is null and
 *     the API resolved the same derivation);
 *  2. the API's audio slot — the list's first entry when it is not
 *     the video (a stored audioUrl whose extension is not
 *     recognised, already resolved by the API);
 *  3. any other non-video candidate whose path ends in an audio
 *     extension (a stored audioUrl on another host);
 *  4. for lists built before the doctrine change ([video, audio,
 *     ...]), the old audio slot — index 1 when index 0 is the
 *     video (even when that slot holds a video-file link: played
 *     with no surface, it is audio in effect);
 *  5. the round's videoUrl itself, audio-only — the last resort.
 * The video is never RENDERED (the question phase has no surface);
 * as a source it simply plays its audio track. Empty when the
 * list holds nothing plausible at all.
 */
export function quizAudioCandidates(
  videoUrl: string | null,
  candidates: (string | null)[],
): string[] {
  const plausible = candidates
    .filter(isPlausibleUrl)
    .filter((url, i, all) => all.indexOf(url) === i);
  if (plausible.length === 0) return [];
  const ordered: string[] = [];
  const push = (url: string | null) => {
    if (url !== null && plausible.includes(url) && !ordered.includes(url)) {
      ordered.push(url);
    }
  };
  push(deriveAudioUrl(videoUrl));
  if (plausible[0] !== videoUrl) push(plausible[0]);
  for (const url of plausible) {
    if (url === videoUrl) continue;
    const path = url.split(/[?#]/)[0].toLowerCase();
    if (AUDIO_FILE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      push(url);
    }
  }
  if (videoUrl && plausible[0] === videoUrl && plausible.length > 1) {
    push(plausible[1]);
  }
  push(videoUrl);
  return ordered;
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
