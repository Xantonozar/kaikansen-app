/**
 * Derived audio URLs — the catalogue's audio gap and its fix.
 *
 * Most `themecaches` documents carry `audioUrl: null`: the seed only
 * ever stored the entry's video links (an entry's stored audioUrl,
 * when present at all, is the LOWEST-resolution video's link — see
 * sync/theme-parser.ts). AnimeThemes, however, hosts a dedicated
 * audio twin for every theme video at a predictable address: the
 * same file name on the audio host with an .ogg extension
 * (`https://v.animethemes.moe/<File>.webm` →
 * `https://a.animethemes.moe/<File>.ogg`). Verified downloadable
 * (HTTP 206, audio/ogg) across the catalogue's decades.
 *
 * RESOLUTION DOCTRINE (owner ruling, 2026-11-10 — supersedes the
 * original "stored data always wins" rule): the stored audioUrl is
 * NOT trusted first, because for a whole class of themes it IS a
 * video link, and serving it as audio left the quiz with nothing
 * playable. Whenever the theme's video link derives, the derived
 * .ogg is the audio — regardless of what is stored. A stored
 * audioUrl is honoured only when nothing derives AND the stored
 * value is not itself a video-file URL; if neither exists the
 * answer is null and callers fall back to the video file played
 * audio-only. Derivation happens on READ (response mapping /
 * payload building) — it is never written back to the shared
 * database.
 */

const VIDEO_PREFIX = 'https://v.animethemes.moe/';
const AUDIO_PREFIX = 'https://a.animethemes.moe/';
const VIDEO_SUFFIX = '.webm';
const AUDIO_SUFFIX = '.ogg';

/**
 * The .ogg audio twin of an AnimeThemes video URL, or null when the
 * video URL does not follow the one verified pattern.
 */
export function deriveAudioUrl(
  videoUrl: string | null | undefined,
): string | null {
  if (typeof videoUrl !== 'string') return null;
  if (!videoUrl.startsWith(VIDEO_PREFIX)) return null;
  if (!videoUrl.endsWith(VIDEO_SUFFIX)) return null;
  const file = videoUrl.slice(
    VIDEO_PREFIX.length,
    videoUrl.length - VIDEO_SUFFIX.length,
  );
  if (file.length === 0) return null;
  return `${AUDIO_PREFIX}${file}${AUDIO_SUFFIX}`;
}

/**
 * Whether a URL points at a video file rather than an audio file:
 * it IS the theme's video URL, or its path ends in the video
 * container extension the catalogue uses (.webm). The seed stored
 * video links in audioUrl slots, so this is how a stored "audio"
 * value is recognised as a video link in disguise.
 */
function isVideoFileUrl(
  url: string,
  videoUrl: string | null | undefined,
): boolean {
  if (url === videoUrl) return true;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return path.endsWith(VIDEO_SUFFIX);
}

/**
 * The audio URL a surface should use for a theme/entry (owner
 * doctrine, 2026-11-10): the derived .ogg twin whenever the video
 * URL derives — regardless of what is stored; else the stored
 * audioUrl when it is a genuine audio link (not a video file);
 * else null.
 */
export function resolveAudioUrl(
  audioUrl: string | null | undefined,
  videoUrl: string | null | undefined,
): string | null {
  const derived = deriveAudioUrl(videoUrl);
  if (derived !== null) return derived;
  if (
    typeof audioUrl === 'string' &&
    audioUrl.length > 0 &&
    !isVideoFileUrl(audioUrl, videoUrl)
  ) {
    return audioUrl;
  }
  return null;
}
