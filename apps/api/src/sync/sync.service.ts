import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { AnimeThemesClient } from './animethemes.client';
import {
  AnimeCache,
  type AnimeCacheDocument,
} from './anime-cache.schema';
import {
  ArtistCache,
  type ArtistCacheDocument,
} from './artist-cache.schema';
import {
  EnrichmentService,
  type EnrichmentCache,
} from './enrichment.service';
import {
  MAX_CONSECUTIVE_PAGE_FAILURES,
  POPULAR_MATCH_FLOOR,
  SyncTiming,
} from './sync.constants';
import {
  cleanPopularAnime,
  parsePopularPairs,
  POPULAR_SONG_OVERRIDES,
  type PopularPair,
} from './popular-list';
import { parseATTheme } from './theme-parser';
import type { AtAnime, AtTheme, ParsedTheme } from './sync.types';

export type SyncJobState = 'idle' | 'running' | 'completed' | 'failed';
export type SyncJobKind = 'themes' | 'popular';

export interface SyncStatus {
  state: SyncJobState;
  kind: SyncJobKind | null;
  year: number | null;
  pagesProcessed: number;
  themesProcessed: number;
  themesInserted: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

function idleStatus(): SyncStatus {
  return {
    state: 'idle',
    kind: null,
    year: null,
    pagesProcessed: 0,
    themesProcessed: 0,
    themesInserted: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };
}

/** Same escaping the web applies before building its match regexes. */
function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The theme-catalogue sync engine: a port of the web's manually-run seed
 * scripts (ZadidSalman/Kaisen `scripts/seed-shared.ts` `runSeedByAnime`
 * + `scripts/seed-utils.ts`) and of the popular-flag admin route, rebuilt
 * as background jobs behind the secret-gated /internal/sync endpoints.
 *
 * Differences from the scripts, all deliberate:
 * - FRESH STATE EVERY RUN — no progress files, no resume. A run re-pages
 *   the whole year filter from page 1; upserts make that idempotent.
 * - Jobs run in-process and asynchronously; POST returns immediately and
 *   GET /internal/sync/status reports progress. One job at a time across
 *   both kinds (a second start while one runs → 409).
 * - Enrichment is cached per anime per run, and ArtistCache.totalThemes
 *   only increments for genuinely NEW theme docs — see EnrichmentService
 *   and {@link SyncService.processTheme} for the two deviation notes.
 * - A page that fails twice is recorded and skipped (the scripts' own
 *   policy); MAX_CONSECUTIVE_PAGE_FAILURES consecutive dead pages fail
 *   the job instead of skipping forever (the scripts had a human at the
 *   terminal; this job does not).
 *
 * The models are OPTIONAL: booted without MONGODB_URI the service is
 * constructed model-less and job starts answer 503 (status still reads).
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private status: SyncStatus = idleStatus();

  /**
   * The currently running (or last) job's promise. Not part of the API —
   * exposed so tests can await job completion deterministically.
   */
  currentJob: Promise<void> | null = null;

  private readonly atClient?: AnimeThemesClient;
  private readonly enrichment?: EnrichmentService;
  private readonly timing: SyncTiming;

  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(AnimeCache.name)
    private readonly animeModel?: Model<AnimeCacheDocument>,
    @Optional()
    @InjectModel(ArtistCache.name)
    private readonly artistModel?: Model<ArtistCacheDocument>,
    @Optional() atClient?: AnimeThemesClient,
    @Optional() enrichment?: EnrichmentService,
    @Optional() timing?: SyncTiming,
  ) {
    this.atClient = atClient;
    this.enrichment = enrichment;
    this.timing = timing ?? new SyncTiming();
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /* ── Job starts ─────────────────────────────────────────────────── */

  startThemesSync(year: number = new Date().getFullYear()): SyncStatus {
    this.assertIdle();
    this.requireModels();
    this.status = {
      ...idleStatus(),
      state: 'running',
      kind: 'themes',
      year,
      startedAt: new Date().toISOString(),
    };
    this.logger.log(`Theme sync started for year ${year}`);
    this.currentJob = this.executeThemesJob(year);
    // The executor records its own failures in the status; this catch
    // only guards against unhandled rejections from unexpected throws.
    this.currentJob.catch((err) =>
      this.logger.error(`Theme sync job crashed: ${err}`),
    );
    return this.getStatus();
  }

  startPopularSync(): SyncStatus {
    this.assertIdle();
    this.requireModels();
    this.status = {
      ...idleStatus(),
      state: 'running',
      kind: 'popular',
      startedAt: new Date().toISOString(),
    };
    this.logger.log('Popular-flag sync started');
    this.currentJob = this.executePopularJob();
    this.currentJob.catch((err) =>
      this.logger.error(`Popular sync job crashed: ${err}`),
    );
    return this.getStatus();
  }

  private assertIdle(): void {
    if (this.status.state === 'running') {
      throw new ConflictException(
        `A ${this.status.kind} sync job is already running`,
      );
    }
  }

  private requireModels(): void {
    if (!this.themeModel || !this.animeModel || !this.artistModel) {
      throw new ServiceUnavailableException(
        'Sync unavailable — API booted without MONGODB_URI',
      );
    }
  }

  /* ── Themes job (runSeedByAnime port) ───────────────────────────── */

  async executeThemesJob(year: number): Promise<void> {
    let page = 1;
    let consecutivePageFailures = 0;
    try {
      const enrichment = this.enrichment;
      if (!this.atClient || !enrichment) {
        throw new Error('Sync engine clients are not configured');
      }
      const cache = enrichment.createCache();
      for (;;) {
        let pageData: { anime?: AtAnime[] };
        try {
          await this.timing.delay(this.timing.atDelayMs);
          pageData = await this.atClient.fetchAnimePage(
            page,
            `filter[anime][year]=${year}`,
          );
          consecutivePageFailures = 0;
        } catch {
          // One retry after the scripts' 5s wait, filter kept (the
          // runSeedByAnime behaviour), then record-and-skip the page.
          try {
            await this.timing.delay(this.timing.pageRetryDelayMs);
            pageData = await this.atClient.fetchAnimePage(
              page,
              `filter[anime][year]=${year}`,
            );
            consecutivePageFailures = 0;
          } catch (retryErr) {
            this.status.errors++;
            consecutivePageFailures++;
            if (consecutivePageFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
              throw new Error(
                `AnimeThemes unreachable — page ${page} failed after retry: ${retryErr}`,
              );
            }
            this.logger.warn(
              `Theme sync: page ${page} failed after retry — skipping`,
            );
            page++;
            continue;
          }
        }

        const animes = pageData.anime ?? [];
        if (animes.length === 0) break;

        for (const atAnime of animes) {
          const themes = atAnime.animethemes ?? [];
          for (const atTheme of themes) {
            // Inject anime into theme for parseATTheme (as the web does).
            atTheme.anime = atAnime;
            await this.processTheme(atTheme, atAnime, cache);
          }
        }

        this.status.pagesProcessed++;
        page++;
      }
      this.status.state = 'completed';
      this.logger.log(
        `Theme sync for ${year} completed: ${this.status.themesProcessed} processed, ${this.status.themesInserted} inserted, ${this.status.errors} errors`,
      );
    } catch (err) {
      this.status.state = 'failed';
      this.status.lastError =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Theme sync failed: ${this.status.lastError}`);
    } finally {
      this.status.finishedAt = new Date().toISOString();
    }
  }

  /**
   * One theme end to end, mirroring runSeedByAnime's per-theme block:
   * parse → enrich → theme upsert → artist upserts → anime upsert.
   * Per-theme failures are counted, never fatal (the scripts' policy).
   */
  private async processTheme(
    atTheme: AtTheme,
    atAnime: AtAnime,
    cache: EnrichmentCache,
  ): Promise<void> {
    const themeModel = this.themeModel as Model<ThemeCacheDocument>;
    const artistModel = this.artistModel as Model<ArtistCacheDocument>;
    const animeModel = this.animeModel as Model<AnimeCacheDocument>;
    const enrichment = this.enrichment;
    try {
      if (!enrichment) {
        throw new Error('EnrichmentService is not configured');
      }
      const parsed = parseATTheme(atTheme);
      if (!parsed) {
        this.status.errors++;
        return;
      }

      const enriched = await enrichment.enrichTheme(parsed, atAnime, cache);
      const finalDoc: ParsedTheme = enriched ?? parsed;

      // The web passes its enriched object straight into $set; its
      // `_nullAudioCount: undefined` bookkeeping field is stripped here
      // explicitly instead (same net document, no reliance on driver
      // handling of undefined update values).
      const { _nullAudioCount: _ignored, ...docForWrite } = finalDoc;

      // Insert detection: updateOne's result reports upsertedCount > 0
      // only when the upsert created a NEW document — the signal the
      // deviation below needs.
      const result = await themeModel
        .updateOne(
          { animethemesId: finalDoc.animethemesId },
          { $set: docForWrite },
          { upsert: true },
        )
        .exec();
      const inserted = ((result?.upsertedCount as number) ?? 0) > 0;
      if (inserted) this.status.themesInserted++;
      this.status.themesProcessed++;

      // Artists — upserted by slug, as in both web engines.
      //
      // DEVIATION (b) — deliberate: the web adds `$inc: { totalThemes: 1 }`
      // on EVERY run, so weekly re-runs would inflate artist theme counts
      // forever. Here the increment applies ONLY when the theme upsert
      // above inserted a genuinely new theme document; the artist's $set
      // fields are refreshed either way.
      const artists = atTheme.song?.artists ?? [];
      for (const artist of artists) {
        if (!artist.slug) continue;
        const update: Record<string, unknown> = {
          $set: {
            slug: artist.slug,
            animethemesId: artist.id,
            name: artist.name,
            aliases: artist.aliases ?? [],
            imageUrl: artist.images?.[0]?.link ?? null,
            syncedAt: new Date(),
          },
        };
        if (inserted) update.$inc = { totalThemes: 1 };
        await artistModel
          .updateOne({ slug: artist.slug }, update, { upsert: true })
          .exec();
      }

      // Anime cache — only for themes whose enrichment found an AniList
      // id; field list is runSeedByAnime's (incl. coverImageMedium,
      // studios, series).
      if (finalDoc.anilistId) {
        await animeModel
          .updateOne(
            { anilistId: finalDoc.anilistId },
            {
              $set: {
                anilistId: finalDoc.anilistId,
                malId: finalDoc.malId ?? null,
                kitsuId: finalDoc.kitsuId,
                titleRomaji: finalDoc.animeTitle,
                titleEnglish: finalDoc.animeTitleEnglish,
                titleNative: finalDoc.titleNative ?? null,
                titleAlternative: finalDoc.animeTitleAlternative,
                synonyms: finalDoc.synonyms ?? [],
                season: finalDoc.animeSeason,
                seasonYear: finalDoc.animeSeasonYear,
                genres: finalDoc.genres ?? [],
                totalEpisodes: finalDoc.totalEpisodes ?? null,
                status: finalDoc.animeStatus ?? null,
                averageScore: finalDoc.averageScore ?? null,
                coverImageLarge: finalDoc.coverImageLarge ?? null,
                coverImageMedium: finalDoc.coverImageMedium ?? null,
                bannerImage: finalDoc.bannerImage ?? null,
                atCoverImage: finalDoc.animeCoverImage,
                atGrillImage: finalDoc.animeGrillImage,
                studios: finalDoc.animeStudios,
                series: finalDoc.animeSeries,
                syncedAt: new Date(),
              },
            },
            { upsert: true },
          )
          .exec();
      }
    } catch (err) {
      this.status.errors++;
      this.logger.warn(
        `Theme sync: theme ${atTheme.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /* ── Popular job (seed-popular port, match-first) ───────────────── */

  async executePopularJob(): Promise<void> {
    const themeModel = this.themeModel as Model<ThemeCacheDocument>;
    try {
      const pairs = parsePopularPairs();

      // MATCH-FIRST: resolve every pair against the catalogue WITHOUT
      // writing anything. The web route reset all flags up front, so a
      // bad matching day (renamed titles, an empty catalogue) wiped the
      // popular rail; here, if too few pairs match, the job aborts with
      // the flags exactly as they were.
      const matchedByDoc = new Map<string, number>(); // doc id → rank
      let matchedPairs = 0;
      for (const pair of pairs) {
        const match = await this.matchPopularPair(pair);
        this.status.themesProcessed++;
        if (match) {
          matchedPairs++;
          // Last match wins for a doc, mirroring the web's sequential
          // findByIdAndUpdate application order.
          matchedByDoc.set(String(match._id), pair.rank);
        } else {
          this.status.errors++;
        }
      }

      if (matchedPairs < POPULAR_MATCH_FLOOR) {
        throw new Error(
          `Popular match floor not met: matched ${matchedPairs} of ${pairs.length} pairs (minimum ${POPULAR_MATCH_FLOOR}) — popular flags left untouched`,
        );
      }

      // Apply: reset everything, then flag the matched docs — the web's
      // order and update shapes, reached only past the floor.
      await themeModel
        .updateMany(
          {},
          { isPopular: false, popularRank: null, featuredAt: null },
        )
        .exec();
      const featuredAt = new Date();
      for (const [docId, rank] of matchedByDoc) {
        await themeModel
          .findByIdAndUpdate(docId, {
            isPopular: true,
            popularRank: rank,
            featuredAt,
          })
          .exec();
      }

      this.status.state = 'completed';
      this.logger.log(
        `Popular sync completed: ${matchedPairs}/${pairs.length} pairs matched, ${matchedByDoc.size} themes flagged`,
      );
    } catch (err) {
      this.status.state = 'failed';
      this.status.lastError =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Popular sync failed: ${this.status.lastError}`);
    } finally {
      this.status.finishedAt = new Date().toISOString();
    }
  }

  /**
   * One pair's matching. Candidate retrieval is ported from the web's
   * seed-popular route (case-insensitive regex over the three title
   * fields; song passes are full-substring, first-two-words regex, the
   * manual overrides map, then a $text fallback) — with two deliberate
   * changes for the curated 50-entry list (2026-11-08):
   *
   * - TYPE-STRICT: an entry is typed OP/ED and only ever flags a theme
   *   of its own type. The web's list was untyped and the route never
   *   looked at the type field, so an OP entry could flag an ED doc
   *   sharing its song title (and vice versa).
   * - DETERMINISTIC PICK: instead of the web's first-candidate-wins,
   *   ALL passing candidates are collected and the winner is chosen by
   *   (1) exact stored song title, (2) exact anime title, (3) lowest
   *   sequence. Franchises re-use songs across entries (One Piece's
   *   "We Are!" is OP1 and OP7; Evangelion has 14 "Fly Me to the Moon"
   *   ED variants), and the curated list always means the iconic one.
   */
  private async matchPopularPair(
    pair: PopularPair,
  ): Promise<{ _id: unknown; songTitle: string } | null> {
    const themeModel = this.themeModel as Model<ThemeCacheDocument>;
    const cleanAnime = cleanPopularAnime(pair.anime);

    const songTerms = pair.song.split(/\s+/).slice(0, 2).join(' ');
    const regexAnime = new RegExp(escapeRegExp(cleanAnime), 'i');
    const regexSongLoose = new RegExp(escapeRegExp(songTerms), 'i');

    const candidates = (await themeModel
      .find({
        $or: [
          { animeTitle: { $regex: regexAnime } },
          { animeTitleEnglish: { $regex: regexAnime } },
          { animeTitleAlternative: { $regex: regexAnime } },
        ],
      })
      .lean()
      .exec()) as PopularCandidate[];

    const passing = candidates.filter(
      (c) =>
        c.type === pair.type &&
        this.popularSongMatches(c.songTitle, pair, regexSongLoose),
    );
    if (passing.length > 0) return this.pickPopularMatch(passing, pair);

    const textMatches = (await themeModel
      .find({ $text: { $search: `"${pair.song}" "${cleanAnime}"` } })
      .limit(5)
      .lean()
      .exec()) as PopularCandidate[];
    const typedText = textMatches.filter((c) => c.type === pair.type);
    return typedText.length > 0
      ? this.pickPopularMatch(typedText, pair)
      : null;
  }

  /** The web route's three song passes, as one predicate. */
  private popularSongMatches(
    songTitle: string,
    pair: PopularPair,
    regexSongLoose: RegExp,
  ): boolean {
    if (songTitle.toLowerCase().includes(pair.song.toLowerCase())) {
      return true;
    }
    if (regexSongLoose.test(songTitle)) return true;
    const overrideSong =
      POPULAR_SONG_OVERRIDES[pair.song] ??
      POPULAR_SONG_OVERRIDES[pair.song.substring(0, 15)];
    return overrideSong
      ? songTitle.toLowerCase().includes(overrideSong.toLowerCase())
      : false;
  }

  /**
   * Deterministic winner among passing candidates: exact stored song
   * title first, then exact anime title (either title field, with the
   * catalogue's bracket/trailing-dot decorations normalised away),
   * then the lowest sequence — the original, iconic entry.
   */
  private pickPopularMatch(
    docs: PopularCandidate[],
    pair: PopularPair,
  ): PopularCandidate {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .replace(/\.$/, '')
        .trim();
    const targetSong = pair.song.toLowerCase();
    const targetAnime = norm(pair.anime);
    const score = (c: PopularCandidate): [number, number, number] => [
      c.songTitle.toLowerCase() === targetSong ? 0 : 1,
      norm(c.animeTitle ?? '') === targetAnime ||
      norm(c.animeTitleEnglish ?? '') === targetAnime
        ? 0
        : 1,
      c.sequence ?? Number.MAX_SAFE_INTEGER,
    ];
    return [...docs].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < 3; i++) {
        if (sa[i] !== sb[i]) return sa[i] - sb[i];
      }
      return 0;
    })[0];
  }
}

/** The fields of a theme doc the popular matcher reads. */
interface PopularCandidate {
  _id: unknown;
  songTitle: string;
  type?: string;
  sequence?: number | null;
  animeTitle?: string;
  animeTitleEnglish?: string | null;
}
