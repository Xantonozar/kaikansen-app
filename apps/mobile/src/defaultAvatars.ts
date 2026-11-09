import type { ImageSourcePropType } from 'react-native';

/**
 * Default avatars — the bundled set of 10 kawaii chibi portraits
 * (assets/default-avatars/) shown for users who have NO avatar of
 * their own. The pick is deterministic: an FNV-1a hash of the seed
 * (prefer the user id, fall back to the username) modulo the set
 * size, so the same user always gets the same chibi on every
 * surface and every device, with no server state.
 */
export const DEFAULT_AVATARS: ImageSourcePropType[] = [
  require('../assets/default-avatars/avatar-01.png'),
  require('../assets/default-avatars/avatar-02.png'),
  require('../assets/default-avatars/avatar-03.png'),
  require('../assets/default-avatars/avatar-04.png'),
  require('../assets/default-avatars/avatar-05.png'),
  require('../assets/default-avatars/avatar-06.png'),
  require('../assets/default-avatars/avatar-07.png'),
  require('../assets/default-avatars/avatar-08.png'),
  require('../assets/default-avatars/avatar-09.png'),
  require('../assets/default-avatars/avatar-10.png'),
];

/**
 * The SAME 10 chibis, hosted on Cloudinary (cloud "chirkut") —
 * index-aligned with DEFAULT_AVATARS: entry i is bundled asset i,
 * hosted. The Edit Profile picker renders the bundled asset
 * (instant, offline-safe) but SAVES this URL as the user's
 * avatarUrl, so the stored value is a plain https image URL the
 * website renders as an ordinary image — that is the point of
 * hosting them. The bundled copies remain the in-app fallback for
 * users who never pick one.
 */
export const DEFAULT_AVATAR_URLS: string[] = [
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-01_n0q719.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-02_wrrwba.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-03_ucq9cu.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-04_bacwk4.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-05_ts5uv7.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-06_h8kfna.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-07_rxcuzd.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-08_lbooac.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-09_ottcje.png',
  'https://res.cloudinary.com/chirkut/image/upload/v1794261844/avatar-10_fvhkoy.png',
];

/** Index of the default a stored avatar URL names, or -1. */
export function defaultAvatarIndexForUrl(url: string | null): number {
  if (url === null) return -1;
  return DEFAULT_AVATAR_URLS.indexOf(url);
}

export function pickDefaultAvatar(seed: string): ImageSourcePropType {
  // FNV-1a (32-bit) over the seed's char codes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return DEFAULT_AVATARS[(hash >>> 0) % DEFAULT_AVATARS.length];
}
