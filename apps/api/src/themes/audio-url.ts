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
 * The rule is deliberately narrow: only an exact
 * `https://v.animethemes.moe/<file>.webm` video URL derives; any
 * other host or shape returns null and callers keep today's
 * behaviour. Derivation happens on READ (response mapping / payload
 * building) — it is never written back to the shared database.
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
 * The audio URL a surface should use for a theme/entry: the stored
 * audioUrl when one exists (stored data always wins — derivation
 * never overwrites it), else the derived .ogg twin of the video URL,
 * else null.
 */
export function resolveAudioUrl(
  audioUrl: string | null | undefined,
  videoUrl: string | null | undefined,
): string | null {
  return audioUrl ?? deriveAudioUrl(videoUrl);
}
