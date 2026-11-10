import type { ImageSourcePropType } from 'react-native';

/**
 * Default artist images — the set of 20 chibi musicians shown for
 * artists whose catalogue image is missing or unusable (owner
 * order 2026-11-10: artists get real defaults like users do, not
 * an initial-letter disc). The images are hosted on Cloudinary
 * (cloud "chirkut", folder kaikansen/default-artists): the same
 * files as the bundled set they replaced (byte-identical to the
 * hosted copies, verified 2026-11-10). The bundled PNGs were
 * deleted from the repo 2026-11-11 (perf problem 14) — the hosted
 * copies are the only ones now.
 *
 * The pick is deterministic: an FNV-1a hash of the artist slug
 * modulo the set size, so the same artist always gets the same
 * image on every surface and every device, with no server state —
 * the exact pattern of defaultAvatars.ts, seeded by slug instead
 * of user id. Index i of DEFAULT_ARTIST_URLS is artist-(i + 1),
 * index-aligned with the old bundled array, so moving the source
 * from bundled to hosted changed no artist's image.
 */
export const DEFAULT_ARTIST_URLS: string[] = [
  'https://res.cloudinary.com/chirkut/image/upload/v1794263665/default-artist-01_m4fhrt.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263665/default-artist-02_uulyv0.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263665/default-artist-03_itzwhv.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263666/default-artist-04_v0sejg.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263667/default-artist-05_mv3wpt.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263666/default-artist-06_iumdsz.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263666/default-artist-07_d7jvoh.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263667/default-artist-08_oyyu0o.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263669/default-artist-09_yefsgq.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263666/default-artist-10_ktnhde.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263665/default-artist-11_qfqrtl.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263667/default-artist-12_agkwc5.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263667/default-artist-13_xhja93.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263667/default-artist-14_ckna2r.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263668/default-artist-15_do3ctp.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263668/default-artist-16_yqow88.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263668/default-artist-17_rj4vkf.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263668/default-artist-18_hjcsiu.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263669/default-artist-19_nnjyez.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794263669/default-artist-20_spgvi9.png',
];

export function pickDefaultArtist(seed: string): ImageSourcePropType {
  // FNV-1a (32-bit) over the seed's char codes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    uri: DEFAULT_ARTIST_URLS[(hash >>> 0) % DEFAULT_ARTIST_URLS.length],
  };
}
