import type { ImageSourcePropType } from 'react-native';

/**
 * Default artist images — the bundled set of 20 chibi musicians
 * (assets/default-artists/) shown for artists whose catalogue image
 * is missing or unusable (owner order 2026-11-10: artists get real
 * defaults like users do, not an initial-letter disc). The pick is
 * deterministic: an FNV-1a hash of the artist slug modulo the set
 * size, so the same artist always gets the same image on every
 * surface and every device, with no server state — the exact
 * pattern of defaultAvatars.ts, seeded by slug instead of user id.
 */
export const DEFAULT_ARTISTS: ImageSourcePropType[] = [
  require('../assets/default-artists/artist-01.png'),
  require('../assets/default-artists/artist-02.png'),
  require('../assets/default-artists/artist-03.png'),
  require('../assets/default-artists/artist-04.png'),
  require('../assets/default-artists/artist-05.png'),
  require('../assets/default-artists/artist-06.png'),
  require('../assets/default-artists/artist-07.png'),
  require('../assets/default-artists/artist-08.png'),
  require('../assets/default-artists/artist-09.png'),
  require('../assets/default-artists/artist-10.png'),
  require('../assets/default-artists/artist-11.png'),
  require('../assets/default-artists/artist-12.png'),
  require('../assets/default-artists/artist-13.png'),
  require('../assets/default-artists/artist-14.png'),
  require('../assets/default-artists/artist-15.png'),
  require('../assets/default-artists/artist-16.png'),
  require('../assets/default-artists/artist-17.png'),
  require('../assets/default-artists/artist-18.png'),
  require('../assets/default-artists/artist-19.png'),
  require('../assets/default-artists/artist-20.png'),
];

export function pickDefaultArtist(seed: string): ImageSourcePropType {
  // FNV-1a (32-bit) over the seed's char codes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return DEFAULT_ARTISTS[(hash >>> 0) % DEFAULT_ARTISTS.length];
}
