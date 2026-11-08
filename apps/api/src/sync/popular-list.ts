/**
 * The curated "popular themes" list — the /home hall-of-fame rail.
 *
 * REBUILT 2026-11-08 on the owner's order, replacing the web's old
 * ~230-pair editorial seed list (ZadidSalman/Kaisen
 * `app/api/admin/seed-popular/route.ts`) with a researched top 50:
 * exactly 30 OPs and 20 EDs, ranked 1–50 by overall popularity.
 *
 * How the ranking was built (November 2026 research pass):
 * - All-time fan polls: TV Asahi's 2024 international anison poll and
 *   TBS's music-professionals poll (both put "A Cruel Angel's Thesis"
 *   first), Ranker's 615k-vote best-OP poll (won by "unravel"), and
 *   r/anime's Best OP tournament history (winners include "Again",
 *   "Hacking to the Gate", "unravel", "KICK BACK").
 * - Streaming weight (Spotify, via Anison100/Kworb reporting): "Duvet"
 *   is the most-streamed anime OP ever (~1.1B), then "Idol" (~600M),
 *   "KICK BACK" (~580M), "Silhouette" (~440M); combined-platform
 *   counts put "Gurenge", "Kaibutsu", "Bling-Bang-Bang-Born",
 *   "Kaikai Kitan" and "Zankyou Sanka" in the same top tier. For EDs,
 *   "LOST IN PARADISE" (~136M), "Comedy"/"Kigeki" (~117M) and
 *   "Akuma no Ko" (~115–129M) lead the streaming era.
 * - Editorial all-time lists (WatchMojo's ED top 20s, MAL's top-25 ED
 *   feature, RouteNote's top-30 OP ranking) for the pre-streaming
 *   icons: Tank!, The Real Folk Blues, Roundabout, Wind, Uso,
 *   Fly Me to the Moon, Moonlight Densetsu, Cha-La Head-Cha-La…
 *
 * Every entry was then VERIFIED against the production catalogue
 * (themecaches): `song` is the theme's exact stored songTitle and
 * `anime` its stored animeTitle, so the matcher in
 * {@link SyncService} resolves each entry to exactly one document —
 * the slug noted beside each entry. Two DB spelling quirks to know:
 * Demon Slayer's "Zankyou Sanka" is stored as "Zankyou Zanka", and
 * Spy x Family's "Comedy" ED is stored under its Japanese title
 * "Kigeki". Famous research hits that missed the final cut only on
 * ranking depth (all verified present in the catalogue) head the
 * alternates: AIZO (Jujutsu Kaisen S3, 2026), Shinzou wo Sasageyo!,
 * COLORS, Sorairo Days, Yuusha, Kawaki wo Ameku (OPs); Hyoriittai,
 * Yasashii Suisei, veil, Orange, Torches (EDs).
 */
export interface PopularPair {
  song: string;
  anime: string;
  rank: number;
  type: 'OP' | 'ED';
}

const E = (
  rank: number,
  type: 'OP' | 'ED',
  song: string,
  anime: string,
): PopularPair => ({ rank, type, song, anime });

export const POPULAR_ENTRIES: PopularPair[] = [
  E(1, 'OP', 'Zankoku na Tenshi no Thesis', 'Neon Genesis Evangelion'), // neon_genesis_evangelion-op1 — A Cruel Angel's Thesis, Yoko Takahashi (1995)
  E(2, 'OP', 'unravel', 'Tokyo Ghoul'), // tokyo_ghoul-op1 — TK from Ling tosite sigure (2014)
  E(3, 'OP', 'Idol', 'Oshi no Ko'), // oshi_no_ko-op1 — YOASOBI (2023)
  E(4, 'OP', 'Tank!', 'Cowboy Bebop'), // cowboy_bebop-op1 — Seatbelts (1998)
  E(5, 'OP', 'Gurenge', 'Kimetsu no Yaiba'), // kimetsu_no_yaiba-op1 — LiSA (2019)
  E(6, 'OP', 'KICK BACK', 'Chainsaw Man'), // chainsaw_man-op1 — Kenshi Yonezu (2022)
  E(7, 'OP', 'Guren no Yumiya', 'Shingeki no Kyojin'), // shingeki_no_kyojin-op1 — Linked Horizon (2013)
  E(8, 'ED', 'LOST IN PARADISE feat. AKLO', 'Jujutsu Kaisen'), // jujutsu_kaisen-ed1 — ALI feat. AKLO (2020)
  E(9, 'OP', 'Kaikai Kitan', 'Jujutsu Kaisen'), // jujutsu_kaisen-op1 — Eve (2020)
  E(10, 'OP', 'Silhouette', 'Naruto: Shippuuden'), // naruto_shippuuden-op16 — KANA-BOON (2014)
  E(11, 'ED', 'The Real Folk Blues', 'Cowboy Bebop'), // cowboy_bebop-ed1 — Seatbelts feat. Mai Yamane (1998)
  E(12, 'OP', 'Blue Bird', 'Naruto: Shippuuden'), // naruto_shippuuden-op3 — Ikimonogakari (2008)
  E(13, 'OP', 'DUVET', 'Serial Experiments Lain'), // serial_experiments_lain-op1 — bôa (1998)
  E(14, 'OP', 'again', 'Fullmetal Alchemist: Brotherhood'), // fullmetal_alchemist_brotherhood-op1 — YUI (2009)
  E(15, 'ED', 'Akuma no Ko', 'Shingeki no Kyojin: The Final Season Part 2'), // shingeki_no_kyojin_the_final_season_part_2-ed1 — Ai Higuchi (2022)
  E(16, 'OP', 'Bling-Bang-Bang-Born', 'Mashle'), // mashle_2nd_season-op1 — Creepy Nuts (2024)
  E(17, 'ED', 'ROUNDABOUT', 'JoJo no Kimyou na Bouken'), // jojo_no_kimyou_na_bouken-ed1 — YES (2012)
  E(18, 'OP', 'Kaibutsu', 'Beastars'), // beastars_2nd_season-op1 — YOASOBI (2021)
  E(19, 'OP', 'SPECIALZ', 'Jujutsu Kaisen 2nd Season'), // jujutsu_kaisen_2nd_season-op2 — King Gnu (2023)
  E(20, 'ED', 'Mephisto', 'Oshi no Ko'), // oshi_no_ko-ed1 — QUEEN BEE (2023)
  E(21, 'OP', 'We Are!', 'One Piece'), // one_piece-op1 — Hiroshi Kitadani (1999)
  E(22, 'OP', 'Cha-La Head-Cha-La', 'Dragon Ball Z'), // dragon_ball_z-op1 — Hironobu Kageyama (1989)
  E(23, 'OP', 'Zankyou Zanka', 'Kimetsu no Yaiba: Yuukaku-hen'), // kimetsu_no_yaiba_yuukaku_hen-op1 — Aimer (2021); stored spelling of "Zankyou Sanka"
  E(24, 'ED', 'Uso', 'Fullmetal Alchemist: Brotherhood'), // fullmetal_alchemist_brotherhood-ed1 — SID (2009)
  E(25, 'OP', 'Inferno', 'Enen no Shouboutai'), // enen_no_shouboutai-op1 — Mrs. GREEN APPLE (2019)
  E(26, 'OP', 'Otonoke', 'Dandadan'), // dandadan-op1 — Creepy Nuts (2024)
  E(27, 'ED', 'Wind', 'Naruto'), // naruto-ed1 — Akeboshi (2002)
  E(28, 'OP', 'Peace Sign', 'Boku no Hero Academia 2nd Season'), // boku_no_hero_academia_2nd_season-op1 — Kenshi Yonezu (2017)
  E(29, 'OP', 'crossing field', 'Sword Art Online'), // sword_art_online-op1 — LiSA (2012)
  E(30, 'ED', 'Fly Me to the Moon', 'Neon Genesis Evangelion'), // neon_genesis_evangelion-ed1 — CLAIRE (1995)
  E(31, 'OP', 'Ao no Sumika', 'Jujutsu Kaisen 2nd Season'), // jujutsu_kaisen_2nd_season-op1 — Tatsuya Kitani (2023)
  E(32, 'OP', 'Butter-Fly', 'Digimon Adventure'), // digimon_adventure-op1 — Kouji Wada (1999)
  E(33, 'ED', 'secret base ~Kimi ga Kureta Mono~ (10 years after ver.)', 'Ano Hi Mita Hana no Namae wo Bokutachi wa Mada Shiranai'), // ano_hi_mita_hana_no_namae_wo_bokutachi_wa_mada_shiranai-ed2 — Kayano, Tomatsu & Hayami (2011)
  E(34, 'OP', 'Kyouran Hey Kids!!', 'Noragami Aragoto'), // noragami_aragoto-op1 — THE ORAL CIGARETTES (2015)
  E(35, 'OP', 'Cry Baby', 'Tokyo Revengers'), // tokyo_revengers-op1 — Official HIGE DANdism (2021)
  E(36, 'ED', 'Magia', 'Mahou Shoujo Madoka★Magica'), // mahou_shoujo_madokamagica-ed2 — Kalafina (2011)
  E(37, 'OP', 'The Rumbling', 'Shingeki no Kyojin: The Final Season Part 2'), // shingeki_no_kyojin_the_final_season_part_2-op1 — SiM (2022)
  E(38, 'ED', 'Kigeki', 'Spy x Family'), // spy_x_family-ed1 — Gen Hoshino (2022); "Comedy"
  E(39, 'ED', 'Anytime Anywhere', 'Sousou no Frieren'), // sousou_no_frieren-ed1 — milet (2023)
  E(40, 'ED', 'Dango Daikazoku', 'Clannad'), // clannad-ed1 — Chata (2007)
  E(41, 'OP', 'Moonlight Densetsu', 'Bishoujo Senshi Sailor Moon'), // bishoujo_senshi_sailor_moon-op1 — DALI (1992)
  E(42, 'ED', 'Sugar Song to Bitter Step', 'Kekkai Sensen'), // kekkai_sensen-ed1 — UNISON SQUARE GARDEN (2015)
  E(43, 'OP', 'Hacking to the Gate', 'Steins;Gate'), // steinsgate-op1 — Kanako Itou (2011)
  E(44, 'ED', 'Hare Hare Yukai', 'Suzumiya Haruhi no Yuuutsu'), // suzumiya_haruhi_no_yuuutsu-ed1 — Hirano, Chihara & Gotou (2006)
  E(45, 'ED', 'Alumina', 'Death Note'), // death_note-ed1 — Nightmare (2006)
  E(46, 'OP', 'THE WORLD', 'Death Note'), // death_note-op1 — Nightmare (2006)
  E(47, 'ED', 'Mosaic Kakera', 'Code Geass: Hangyaku no Lelouch'), // code_geass_hangyaku_no_lelouch-ed2 — SunSet Swish (2007)
  E(48, 'ED', 'Fukai Mori', 'InuYasha'), // inuyasha-ed2 — Do As Infinity (2001)
  E(49, 'ED', 'Shiki no Uta', 'Samurai Champloo'), // samurai_champloo-ed1 — MINMI (2004)
  E(50, 'ED', 'Hunting for Your Dream.', 'Hunter x Hunter'), // hunter_x_hunter_2011-ed2 — Galneryus (2012)
];

/**
 * The curated pairs in rank order. Kept under the port's original name
 * (the sync job and its specs consume pairs, not the raw list); each
 * call returns fresh copies so callers can't mutate the canon.
 */
export function parsePopularPairs(): PopularPair[] {
  return POPULAR_ENTRIES.map((p) => ({ ...p })).sort(
    (a, b) => a.rank - b.rank,
  );
}

/**
 * Manual song-title overrides, ported from the web route (keys are a
 * pair's full song title, or its first 15 chars). The curated entries
 * already carry the catalogue's exact stored titles, so these are a
 * dormant safety net — the matcher still consults them after its
 * substring/regex passes, exactly as the web route did.
 */
export const POPULAR_SONG_OVERRIDES: Record<string, string> = {
  "A Cruel Angel's Thesis": 'Zankoku na Tenshi no Thesis',
  'The Hero!!': 'THE HERO !! ~Okoreru Kobushi ni Hi wo Tsukero~',
  Bling: 'Bling-Bang-Bang-Born',
  'Catch You Catch Me': 'Catch You Catch Me',
  'Gekkan Shoujo Nozaki': 'Kimi Janakya Dame Mitai',
  'Inner Universe': 'inner universe',
  'Sugar Song to Bitter Step': 'Sugar Song to Bitter Step',
  Butter: 'Butter-Fly',
  Cha: 'CHA-LA HEAD-CHA-LA',
  'Peace Sign': 'Peace Sign',
  Asterisk: '*~Asterisk~',
  'Zankyou Sanka': 'Zankyou Sanka',
  'Departure!': 'departure!',
  'Odd Future': 'ODD FUTURE',
  'Bloody Stream': 'BLOODY STREAM',
  'Great Days': 'Great Days',
  'Fly High!!': 'FLY HIGH',
  '99.9': '99.9',
  'Ready Steady Go': 'READY STEADY GO',
};

/** Anime-title alias fixes applied before matching, verbatim from the web route. */
export function cleanPopularAnime(anime: string): string {
  const cleaned = anime
    .replace(/season \d+/i, '')
    .replace(/ S\d+/i, '')
    .replace(/ OVA/i, '')
    .replace('2nd Season', '')
    .trim();
  if (cleaned === 'FMA:B') return 'Fullmetal Alchemist';
  if (cleaned === 'SAO') return 'Sword Art Online';
  if (cleaned === 'MHA') return 'My Hero Academia';
  if (cleaned === 'Deer Child') return 'Shikanoko';
  return cleaned;
}
