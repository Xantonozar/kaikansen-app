import { Injectable } from '@nestjs/common';

/**
 * Constants ported from the web's seed scripts
 * (ZadidSalman/Kaisen `scripts/seed-utils.ts` / `scripts/seed-shared.ts`).
 */
export const AT_BASE = 'https://api.animethemes.moe';
export const AT_USER_AGENT = 'Kaikansen/1.0.0';

/** Include string of the web's `runSeedByAnime` engine (seed-shared.ts). */
export const ANIME_INCLUDE =
  'images,studios,series,animethemes.animethemeentries.videos,animethemes.song.artists';

/** AnimeThemes — be polite (seed-utils.ts). */
export const AT_DELAY_MS = 700;
/** AniList — avoid rate limit (seed-utils.ts). */
export const ANILIST_DELAY_MS = 2000;
/** Kitsu — generous free tier (seed-utils.ts). */
export const KITSU_DELAY_MS = 500;
/** Page-fetch failure wait before the single retry (seed-shared.ts). */
export const PAGE_RETRY_DELAY_MS = 5000;

/**
 * Minimum number of editorial pairs that must match before the popular
 * job is allowed to touch any flags (match-first safety floor — this API's
 * own guard; the web route reset the flags unconditionally).
 */
export const POPULAR_MATCH_FLOOR = 100;

/**
 * Safety valve with no counterpart in the web scripts: they ran in a
 * terminal where a human could Ctrl-C a stuck run. An unattended job must
 * not page forever against a dead API, so this many consecutive
 * double-failed pages fails the job instead of skipping forever.
 */
export const MAX_CONSECUTIVE_PAGE_FAILURES = 5;

/**
 * Injectable timing knobs for the sync engine. Production uses the web
 * scripts' own delays; tests zero them out. Every delay in the engine
 * goes through {@link SyncTiming.delay} so a test run never sleeps.
 */
@Injectable()
export class SyncTiming {
  atDelayMs = AT_DELAY_MS;
  anilistDelayMs = ANILIST_DELAY_MS;
  kitsuDelayMs = KITSU_DELAY_MS;
  pageRetryDelayMs = PAGE_RETRY_DELAY_MS;

  delay(ms: number): Promise<void> {
    return ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();
  }
}
