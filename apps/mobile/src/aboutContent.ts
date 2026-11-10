/**
 * About screen content (release readiness, 2026-11-11) — the
 * FACTS the About screen renders, kept pure and separate so the
 * copy is unit-tested (aboutContent.test.ts) and the screen stays
 * a thin renderer.
 *
 * Every line is real, sourced from the project record:
 * - the description is the app's actual feature set (theme
 *   listening/watching + solo & multiplayer quizzes);
 * - "What's new" lists only work that actually shipped in the
 *   1.0.0 build (the 2026-11-10/11 chain: 24-rank ladder + Curve B
 *   RP, real Weekly leaderboard, Atlas search, the offline screen,
 *   the playback split);
 * - credits name the real data sources (AnimeThemes catalogue &
 *   media, AniList anime data, Cloudinary artwork hosting) and
 *   the developer.
 * No marketing inflation, no placeholder numbers.
 */

export const ABOUT_DESCRIPTION =
  'Listen to and watch anime opening & ending themes, and quiz yourself and friends on them.';

export const ABOUT_WHATS_NEW: readonly string[] = [
  'A 24-rank ladder with rebalanced RP — climb from Academy Student to Pirate King',
  'Weekly leaderboard, ranked by the RP you earn each week',
  'Faster search that finds partial titles (try "naru")',
  'An offline screen that hands you your downloads when the connection drops',
  'Smoother playback — audio and video each on their best player',
];

export interface AboutCredit {
  label: string;
  value: string;
}

export const ABOUT_CREDITS: readonly AboutCredit[] = [
  { label: 'Theme catalogue & media', value: 'AnimeThemes (animethemes.moe)' },
  { label: 'Anime data', value: 'AniList' },
  { label: 'Artwork hosting', value: 'Cloudinary' },
  { label: 'Developed by', value: 'Salman Ahmed Zadid (ozar)' },
];

export interface AboutLink {
  label: string;
  url: string;
}

export const ABOUT_LINKS: readonly AboutLink[] = [
  { label: 'Website', url: 'https://kaiseen.vercel.app' },
  { label: 'AniList', url: 'https://anilist.co' },
];

/** "Version 1.0.0 (build 2)" — from the runtime-read build facts. */
export function aboutVersionLine(version: string, versionCode: number): string {
  return `Version ${version} (build ${versionCode})`;
}
