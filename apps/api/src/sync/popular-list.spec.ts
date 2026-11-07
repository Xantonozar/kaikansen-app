import { cleanPopularAnime, parsePopularPairs } from './popular-list';

describe('parsePopularPairs (web seed-popular list port)', () => {
  const pairs = parsePopularPairs();

  it('parses the full editorial list (~230 pairs) with sequential ranks', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(200);
    expect(pairs.length).toBeLessThanOrEqual(260);
    pairs.forEach((p, i) => expect(p.rank).toBe(i + 1));
  });

  it('starts with the Hall of Fame in order', () => {
    expect(pairs[0]).toEqual({
      song: "A Cruel Angel's Thesis",
      anime: 'Neon Genesis Evangelion',
      rank: 1,
    });
    expect(pairs[1]).toEqual({ song: 'Unravel', anime: 'Tokyo Ghoul', rank: 2 });
    expect(pairs[3]).toEqual({ song: 'Tank!', anime: 'Cowboy Bebop', rank: 4 });
  });

  it('skips emoji section headers and blank lines', () => {
    for (const p of pairs) {
      expect(p.song).not.toMatch(/🏆|🔥|⚔️|🎷|🏛️|🌸|📜|🌌/);
      expect(p.song.length).toBeGreaterThan(0);
      expect(p.anime.length).toBeGreaterThan(0);
    }
  });

  it('parses the pipe-packed deep-cuts line into Song (Anime) pairs', () => {
    const crossing = pairs.find((p) => p.song === 'Crossing Field');
    expect(crossing?.anime).toBe('SAO');
    const gold = pairs.find((p) => p.song === 'Gold');
    expect(gold?.anime).toBe('Boruto');
  });

  it('strips printed numbers and surrounding quotes on plain lines', () => {
    const recollect = pairs.find((p) => p.song === 'Recollect');
    expect(recollect?.anime).toBe('Re:Zero Season 4');
    const roundabout = pairs.find((p) => p.song === 'Roundabout');
    expect(roundabout?.anime).toBe('JoJo’s Bizarre Adventure');
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
