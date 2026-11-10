/**
 * Image URL variant selection (perf problem 11) — pure helpers
 * that pick the right-sized stored variant for a display slot,
 * so list rows stop downloading hero-sized art.
 *
 * The data model (verified against the API + sync code):
 * - ThemeSummary/ThemeDetail carry TWO theme cover fields,
 *   `animeCoverImage` (the LARGE one) and `animeCoverImageSmall`.
 *   The small field is NOT one host's variant: by sync provenance
 *   it is AnimeThemes' small cover for AT-sourced themes, or
 *   AniList's `coverImage.medium` once AniList enrichment has
 *   run — either way it is the row-sized variant of the same
 *   cover, and `animeCoverImage` is the large variant (AT large
 *   or AniList `coverImage.large`). So slot selection is simply:
 *   rows/thumbs → small first, heroes → large first, with the
 *   other field as the only fallback. (AniList-only surfaces
 *   that carry coverImageMedium/coverImageLarge directly —
 *   RelatedAnime, the anime detail payload — select the same
 *   way; SearchAnimeResult carries only the large field, so its
 *   rows cannot downshift — recorded in the problem-11 report.)
 * - `animeGrillImage` (detail heroes) is the AniList BANNER
 *   (~1900px) when present — hero slots only, never a thumb.
 * - Cloudinary (own assets only — cloud "chirkut"): avatars,
 *   artist defaults and rank icons are served at fixed small
 *   display sizes, so a width transform is inserted into the
 *   delivery URL (`/image/upload/` → `/image/upload/w_<n>,c_limit/`).
 *   Only URLs on res.cloudinary.com are ever rewritten; anything
 *   else passes through untouched (never proxy third-party art).
 *
 * Hosts with no variant mechanism (R2 backups, DiceBear, kitsu):
 * URL unchanged — expo-image's cache/downsampling is their fix.
 */

/** Display slots the app renders artwork into. */
export type ImageSlot = 'thumb' | 'row' | 'card' | 'hero';

/**
 * The cover pair every theme-shaped payload carries (ThemeSummary,
 * ThemeDetail, queue items, history entries…). Both fields are
 * the same cover at two sizes — see the header note.
 */
export interface ThemeCoverFields {
  animeCoverImage: string | null;
  animeCoverImageSmall: string | null;
}

/**
 * Theme cover for a slot: thumb/row/card slots get the SMALL
 * variant first (AT small / AniList medium), hero slots get the
 * LARGE variant first. The other field is the fallback when the
 * preferred variant is missing.
 */
export function themeCoverForSlot(
  fields: ThemeCoverFields,
  slot: ImageSlot,
): string | null {
  if (slot === 'hero') {
    return fields.animeCoverImage ?? fields.animeCoverImageSmall;
  }
  return fields.animeCoverImageSmall ?? fields.animeCoverImage;
}

/**
 * AniList cover pair (payloads that carry the AniList fields
 * directly — RelatedAnime, anime detail): medium for row/thumb
 * slots, large only for heroes/banners.
 */
export function anilistCoverForSlot(
  fields: { coverImageLarge: string | null; coverImageMedium: string | null },
  slot: ImageSlot,
): string | null {
  if (slot === 'hero') {
    return fields.coverImageLarge ?? fields.coverImageMedium;
  }
  return fields.coverImageMedium ?? fields.coverImageLarge;
}

const CLOUDINARY_UPLOAD_MARKER = '/image/upload/';

/**
 * Cloudinary width transform for OWN assets (avatars, artist
 * defaults, rank icons — all on cloud "chirkut"). Inserts
 * `w_<width>,c_limit` right after `/image/upload/`, ahead of any
 * version segment — Cloudinary's canonical transform position.
 * Non-Cloudinary URLs, and URLs that already carry a transform
 * segment (first path segment after upload/ contains a `,` or
 * matches a transform key like `w_`), pass through unchanged.
 */
export function cloudinarySized(url: string, width: number): string {
  if (!url.includes('res.cloudinary.com')) return url;
  const markerAt = url.indexOf(CLOUDINARY_UPLOAD_MARKER);
  if (markerAt < 0) return url;
  const rest = url.slice(markerAt + CLOUDINARY_UPLOAD_MARKER.length);
  const firstSegment = rest.split('/')[0] ?? '';
  // A transform segment is comma-joined params (w_200,c_limit) or a
  // lone key (w_200); a version segment is v<digits>; anything else
  // is a public-id path — only transform when none is present.
  if (
    firstSegment.includes(',') ||
    /^[a-z]{1,3}_/.test(firstSegment)
  ) {
    return url;
  }
  return `${url.slice(0, markerAt + CLOUDINARY_UPLOAD_MARKER.length)}w_${width},c_limit/${rest}`;
}

/**
 * The Avatar fallback chain's usability test (audit-fix items
 * 7/8): a URL is RENDERABLE when it exists and is not an SVG.
 * DiceBear carries the format as a PATH segment
 * (`.../7.x/adventurer/svg?seed=...`), never as a '.svg'
 * substring — so the test strips query/hash and checks the path
 * ending ('.svg' or '/svg'), exactly the rule Avatar.tsx shipped
 * with; the substring version let every DiceBear URL through and
 * rendered blank (owner-reported 2026-11-10). Kept pure here so
 * the chain is unit-testable without rendering.
 */
export function isRenderableImageUrl(url: string | null): boolean {
  if (url === null || url.length === 0) return false;
  const path = url.toLowerCase().split(/[?#]/)[0];
  return !path.endsWith('.svg') && !path.endsWith('/svg');
}

/**
 * The deterministic-chibi step of the avatar chain: the stored
 * URL is used only when it is renderable AND has not already
 * failed to load on this surface (the failure is keyed by the
 * exact URL, so a changed avatarUrl is tried fresh).
 */
export function avatarUrlUsable(
  url: string | null,
  failedUrl: string | null,
): boolean {
  return isRenderableImageUrl(url) && failedUrl !== url;
}
