import {
  cleanPopularAnime,
  parsePopularPairs,
  POPULAR_ENTRIES,
} from './popular-list';

describe('curated popular list (2026-11-08 rebuild)', () => {
  const pairs = parsePopularPairs();

  it('holds exactly 50 entries with ranks 1–50 in order', () => {
    expect(POPULAR_ENTRIES).toHaveLength(50);
    expect(pairs).toHaveLength(50);
    pairs.forEach((p, i) => expect(p.rank).toBe(i + 1));
  });

  it('is composed of exactly 30 OPs and 20 EDs', () => {
    expect(pairs.filter((p) => p.type === 'OP')).toHaveLength(30);
    expect(pairs.filter((p) => p.type === 'ED')).toHaveLength(20);
  });

  it('opens with the researched all-time top tier', () => {
    expect(pairs[0]).toEqual({
      song: 'Zankoku na Tenshi no Thesis',
      anime: 'Neon Genesis Evangelion',
      rank: 1,
      type: 'OP',
    });
    expect(pairs[1]).toEqual({
      song: 'unravel',
      anime: 'Tokyo Ghoul',
      rank: 2,
      type: 'OP',
    });
    expect(pairs[3]).toEqual({
      song: 'Tank!',
      anime: 'Cowboy Bebop',
      rank: 4,
      type: 'OP',
    });
    // The top ED is Jujutsu Kaisen's Lost in Paradise at rank 8.
    expect(pairs[7]).toEqual({
      song: 'LOST IN PARADISE feat. AKLO',
      anime: 'Jujutsu Kaisen',
      rank: 8,
      type: 'ED',
    });
    expect(pairs[49]).toEqual({
      song: 'Hunting for Your Dream.',
      anime: 'Hunter x Hunter',
      rank: 50,
      type: 'ED',
    });
  });

  it('has no duplicate (song, anime) entries and no empty fields', () => {
    const keys = pairs.map((p) => `${p.song}::${p.anime}`);
    expect(new Set(keys).size).toBe(50);
    for (const p of pairs) {
      expect(p.song.length).toBeGreaterThan(0);
      expect(p.anime.length).toBeGreaterThan(0);
    }
  });

  it('carries the catalogue spellings for the two known title quirks', () => {
    // Stored in themecaches as "Zankyou Zanka" (not "Sanka") and as
    // "Kigeki" (not "Comedy") — the pairs must use the stored titles
    // or they can never match.
    const aimer = pairs.find((p) => p.rank === 23);
    expect(aimer?.song).toBe('Zankyou Zanka');
    expect(aimer?.anime).toBe('Kimetsu no Yaiba: Yuukaku-hen');
    const hoshino = pairs.find((p) => p.rank === 38);
    expect(hoshino?.song).toBe('Kigeki');
    expect(hoshino?.anime).toBe('Spy x Family');
  });

  it('returns fresh copies (callers cannot mutate the canon)', () => {
    const a = parsePopularPairs();
    a[0].song = 'MUTATED';
    expect(parsePopularPairs()[0].song).toBe('Zankoku na Tenshi no Thesis');
    expect(POPULAR_ENTRIES[0].song).toBe('Zankoku na Tenshi no Thesis');
  });
});

describe('cleanPopularAnime', () => {
  it('strips season markers like the web route', () => {
    expect(cleanPopularAnime('Jujutsu Kaisen Season 2')).toBe('Jujutsu Kaisen');
    expect(cleanPopularAnime('Solo Leveling S2')).toBe('Solo Leveling');
    expect(cleanPopularAnime('Some Show OVA')).toBe('Some Show');
    expect(cleanPopularAnime('Attack on Titan Final Season')).toBe(
      'Attack on Titan Final Season',
    );
  });

  it('applies the alias fixes', () => {
    expect(cleanPopularAnime('FMA:B')).toBe('Fullmetal Alchemist');
    expect(cleanPopularAnime('SAO')).toBe('Sword Art Online');
    expect(cleanPopularAnime('MHA')).toBe('My Hero Academia');
    expect(cleanPopularAnime('Deer Child')).toBe('Shikanoko');
  });
});
