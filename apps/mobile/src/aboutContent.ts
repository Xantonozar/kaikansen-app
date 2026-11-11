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
 *   current release (1.0.2, the speed release: no image fade,
 *   instant cold open from the disk first-paint snapshot, skeleton
 *   loading everywhere, search + leaderboard memory; builds on
 *   1.0.1 — the video-watch fix and the polish batch);
 * - credits name the real data sources (AnimeThemes catalogue &
 *   media, AniList anime data, Cloudinary artwork hosting) and
 *   the developer.
 * No marketing inflation, no placeholder numbers.
 */

export const ABOUT_DESCRIPTION =
  'Listen to and watch anime opening & ending themes, and quiz yourself and friends on them.';

export const ABOUT_WHATS_NEW: readonly string[] = [
  'Faster cold opens — Home paints instantly from a saved snapshot',
  'No more image fade-in, and skeleton loading instead of spinners',
  'Leaderboard and search now remember — revisits are instant',
  'Video watching fixed — themes play their video properly (from 1.0.1)',
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

/** "Version 1.0.2 (build 4)" — from the runtime-read build facts. */
export function aboutVersionLine(version: string, versionCode: number): string {
  return `Version ${version} (build ${versionCode})`;
}
