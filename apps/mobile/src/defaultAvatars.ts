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

export function pickDefaultAvatar(seed: string): ImageSourcePropType {
  // FNV-1a (32-bit) over the seed's char codes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return DEFAULT_AVATARS[(hash >>> 0) % DEFAULT_AVATARS.length];
}
