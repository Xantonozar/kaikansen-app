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
 */
export function resolvePlaybackUrl(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
  mode: PlaybackMode,
): string | null {
  if (!entry) {
    return mode === 'watch' ? detail.videoUrl : detail.audioUrl;
  }
  if (mode === 'watch') {
    const best = [...entry.videoSources].sort(
      (a, b) => b.resolution - a.resolution,
    )[0];
    return best?.url ?? entry.videoUrl ?? detail.videoUrl;
  }
  return entry.audioUrl ?? detail.audioUrl;
}

/** Whether listen mode has anything to play for this entry. */
export function entryHasAudio(
  detail: ThemeDetail,
  entry: ThemeEntry | null,
): boolean {
  return resolvePlaybackUrl(detail, entry, 'listen') !== null;
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
