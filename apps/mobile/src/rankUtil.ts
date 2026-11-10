import type {
  LadderRank,
  LadderStanding,
} from '@kaikansen/contracts';

/**
 * The app's 24-rank ladder — the ONLY rank system the app
 * displays. A pure function of RP with the owner's REAL
 * thresholds (spec RANK-RP-PLAN-2026-11-11.md, "Curve B",
 * decided 2026-11-11, replacing the design-stage placeholders);
 * the API derives the identical standing server-side
 * (ladderForRp in the API's quiz-game.utils — the two tables
 * and their boundary tests are mirrors, keep them in step).
 * The web's 6 tiers still arrive on rank payloads (the shared
 * database's legacy field) but no app surface phrases them any
 * more; divisions are gone from display entirely.
 *
 * PROGRESS TARGET (owner decision 2026-11-11): the bar and the
 * "N RP to X" line aim at the NEXT rank — progress is measured
 * within the current step, [current threshold, next threshold).
 *
 * NO FLOOR (same decision): the standing derives from current
 * RP alone, never from a peak — an RP drop below a threshold
 * demotes the displayed rank.
 */

export interface LadderRankInfo {
  rank: LadderRank;
  label: string;
  /** The anime the rank's title/icon comes from (ladder rows). */
  source: string;
  min: number;
  /** Cloudinary delivery URL (cloud chirkut, verified 2026-11-10). */
  iconUrl: string;
  /** Bundled webp fallback (assets/ranks) for offline/failure. */
  iconAsset: number;
}

const CLOUD = 'https://res.cloudinary.com/chirkut/image/upload';

export const LADDER: LadderRankInfo[] = [
  { rank: 'academy-student', label: 'Academy Student', source: 'Naruto', min: 0, iconUrl: `${CLOUD}/v1794313741/rank-01-academy-student.webp`, iconAsset: require('../assets/ranks/rank-01-academy-student.webp') },
  { rank: 'scout', label: 'Scout', source: 'Attack on Titan', min: 100, iconUrl: `${CLOUD}/v1794313742/rank-02-scout.webp`, iconAsset: require('../assets/ranks/rank-02-scout.webp') },
  { rank: 'mizunoto', label: 'Mizunoto', source: 'Demon Slayer', min: 250, iconUrl: `${CLOUD}/v1794313742/rank-03-mizunoto.webp`, iconAsset: require('../assets/ranks/rank-03-mizunoto.webp') },
  { rank: 'genin', label: 'Genin', source: 'Naruto', min: 450, iconUrl: `${CLOUD}/v1794313742/rank-04-genin.webp`, iconAsset: require('../assets/ranks/rank-04-genin.webp') },
  { rank: 'chunin', label: 'Chunin', source: 'Naruto', min: 700, iconUrl: `${CLOUD}/v1794313742/rank-05-chunin.webp`, iconAsset: require('../assets/ranks/rank-05-chunin.webp') },
  { rank: 'shinobi', label: 'Shinobi', source: 'Naruto', min: 1100, iconUrl: `${CLOUD}/v1794313744/rank-06-shinobi.webp`, iconAsset: require('../assets/ranks/rank-06-shinobi.webp') },
  { rank: 'assassin', label: 'Assassin', source: 'Fate', min: 1600, iconUrl: `${CLOUD}/v1794313745/rank-07-assassin.webp`, iconAsset: require('../assets/ranks/rank-07-assassin.webp') },
  { rank: 'firebender', label: 'Firebender', source: 'Avatar', min: 2300, iconUrl: `${CLOUD}/v1794313746/rank-08-firebender.webp`, iconAsset: require('../assets/ranks/rank-08-firebender.webp') },
  { rank: 'kitsune', label: 'Kitsune', source: 'Naruto / folklore', min: 3200, iconUrl: `${CLOUD}/v1794313747/rank-09-kitsune.webp`, iconAsset: require('../assets/ranks/rank-09-kitsune.webp') },
  { rank: 'lone-wolf', label: 'Lone Wolf', source: 'Lone Wolf and Cub', min: 4200, iconUrl: `${CLOUD}/v1794313748/rank-10-lone-wolf.webp`, iconAsset: require('../assets/ranks/rank-10-lone-wolf.webp') },
  { rank: 'karasu', label: 'Karasu', source: 'Naruto', min: 5400, iconUrl: `${CLOUD}/v1794313748/rank-11-karasu.webp`, iconAsset: require('../assets/ranks/rank-11-karasu.webp') },
  { rank: 'jonin', label: 'Jonin', source: 'Naruto', min: 6800, iconUrl: `${CLOUD}/v1794313750/rank-12-jonin.webp`, iconAsset: require('../assets/ranks/rank-12-jonin.webp') },
  { rank: 'ronin', label: 'Ronin', source: 'Rurouni Kenshin', min: 8400, iconUrl: `${CLOUD}/v1794313751/rank-13-ronin.webp`, iconAsset: require('../assets/ranks/rank-13-ronin.webp') },
  { rank: 'shogun', label: 'Shogun', source: 'One Piece', min: 10200, iconUrl: `${CLOUD}/v1794313753/rank-14-shogun.webp`, iconAsset: require('../assets/ranks/rank-14-shogun.webp') },
  { rank: 'anbu', label: 'ANBU', source: 'Naruto', min: 12200, iconUrl: `${CLOUD}/v1794313753/rank-15-anbu.webp`, iconAsset: require('../assets/ranks/rank-15-anbu.webp') },
  { rank: 'pilot', label: 'Pilot', source: 'Evangelion', min: 14500, iconUrl: `${CLOUD}/v1794313754/rank-16-pilot.webp`, iconAsset: require('../assets/ranks/rank-16-pilot.webp') },
  { rank: 'sannin', label: 'Sannin', source: 'Naruto', min: 17000, iconUrl: `${CLOUD}/v1794313755/rank-17-sannin.webp`, iconAsset: require('../assets/ranks/rank-17-sannin.webp') },
  { rank: 'berserk', label: 'Berserk', source: 'Evangelion', min: 19800, iconUrl: `${CLOUD}/v1794313756/rank-18-berserk.webp`, iconAsset: require('../assets/ranks/rank-18-berserk.webp') },
  { rank: 'wizard-king', label: 'Wizard King', source: 'Black Clover', min: 22800, iconUrl: `${CLOUD}/v1794313757/rank-19-wizard-king.webp`, iconAsset: require('../assets/ranks/rank-19-wizard-king.webp') },
  { rank: 'jinchuriki', label: 'Jinchuriki', source: 'Naruto', min: 25800, iconUrl: `${CLOUD}/v1794313759/rank-20-jinchuriki.webp`, iconAsset: require('../assets/ranks/rank-20-jinchuriki.webp') },
  { rank: 'newtype', label: 'Newtype', source: 'Gundam', min: 28800, iconUrl: `${CLOUD}/v1794313760/rank-21-newtype.webp`, iconAsset: require('../assets/ranks/rank-21-newtype.webp') },
  { rank: 'overlord', label: 'Overlord', source: 'Overlord', min: 31800, iconUrl: `${CLOUD}/v1794313760/rank-22-overlord.webp`, iconAsset: require('../assets/ranks/rank-22-overlord.webp') },
  { rank: 'shadow-monarch', label: 'Shadow Monarch', source: 'Solo Leveling', min: 33400, iconUrl: `${CLOUD}/v1794313761/rank-23-shadow-monarch.webp`, iconAsset: require('../assets/ranks/rank-23-shadow-monarch.webp') },
  { rank: 'pirate-king', label: 'Pirate King', source: 'One Piece', min: 35000, iconUrl: `${CLOUD}/v1794313763/rank-24-pirate-king.webp`, iconAsset: require('../assets/ranks/rank-24-pirate-king.webp') },
];

const BY_RANK = new Map(LADDER.map((info, index) => [info.rank, { info, index }]));

/** The ladder entry for a rank slug (Academy Student on junk input). */
export function ladderInfo(rank: LadderRank | string): LadderRankInfo {
  return BY_RANK.get(rank as LadderRank)?.info ?? LADDER[0];
}

/** "Shadow Monarch" — the rank's display name. */
export function ladderLabel(rank: LadderRank | string): string {
  return ladderInfo(rank).label;
}

/**
 * The standing for an RP total — the exact mirror of the API's
 * ladderForRp (same thresholds, same progress-target rule).
 * Prefer a served `ladder` field when one is at hand
 * (standingOf); this derives for values the client already
 * holds (socket events, fixtures).
 */
export function ladderForRp(rp: number): LadderStanding {
  const safe = Number.isFinite(rp) ? Math.max(0, Math.floor(rp)) : 0;
  let idx = 0;
  for (let i = 0; i < LADDER.length; i++) {
    if (safe >= LADDER[i].min) idx = i;
    else break;
  }
  const cur = LADDER[idx];
  const target = LADDER[idx + 1] ?? null;
  if (!target) {
    return { rank: cur.rank, index: idx, nextRank: null, toNext: 0, fraction: 1 };
  }
  const span = target.min - cur.min;
  const done = Math.min(Math.max(safe - cur.min, 0), span);
  return {
    rank: cur.rank,
    index: idx,
    nextRank: target.rank,
    toNext: target.min - safe,
    fraction: span > 0 ? done / span : 1,
  };
}

/**
 * The standing to draw for a rank payload: the served ladder
 * field when present (the API's derivation), else derived from
 * the RP locally (older payloads, fixtures).
 */
export function standingOf(payload: {
  rp: number;
  ladder?: LadderStanding;
}): LadderStanding {
  return payload.ladder ?? ladderForRp(payload.rp);
}

/** "1,270 RP" — grouped RP figure, as drawn on the rank surfaces. */
export function formatRp(rp: number): string {
  return `${rp.toLocaleString('en-US')} RP`;
}
