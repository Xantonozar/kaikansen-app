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
 *   current release (1.0.1: the video-watch fix — one stable video
 *   surface — plus the polish batch; the 1.0.0 chain it builds on:
 *   24-rank ladder + Curve B RP, real Weekly leaderboard, Atlas
 *   search, the offline screen, the playback split);
 * - credits name the real data sources (AnimeThemes catalogue &
 *   media, AniList anime data, Cloudinary artwork hosting) and
 *   the developer.
 * No marketing inflation, no placeholder numbers.
 */

export const ABOUT_DESCRIPTION =
  'Listen to and watch anime opening & ending themes, and quiz yourself and friends on them.';

export const ABOUT_WHATS_NEW: readonly string[] = [
  'Video watching fixed — themes now play their video properly on the theme page',
  'Leaderboard scrolls smoothly, with a Weekly caption',
  'Profile sections that fail to load now offer a Retry instead of vanishing',
  'Honest progress bars — no more fake fills on downloads',
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

/** "Version 1.0.1 (build 3)" — from the runtime-read build facts. */
export function aboutVersionLine(version: string, versionCode: number): string {
  return `Version ${version} (build ${versionCode})`;
}
