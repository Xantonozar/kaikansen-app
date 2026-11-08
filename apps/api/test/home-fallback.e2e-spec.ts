import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { currentSeason, previousSeason } from './../src/themes/season';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { ThemesController } from './../src/themes/themes.controller';
import { ThemesService } from './../src/themes/themes.service';

/**
 * GET /home over real HTTP with a mocked catalogue (owner's order,
 * 2026-11-08): the CURRENT season — whatever it is on the day the
 * suite runs — holds nothing, the season right before it holds one
 * theme. The response must serve that theme labelled with the season
 * it actually belongs to, never the current one.
 */

/** Chainable Mongoose-query stand-in. */
function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.limit = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

describe('GET /home season fallback (e2e)', () => {
  let app: INestApplication;

  const served = previousSeason(currentSeason(new Date()));
  const fallbackDoc = {
    _id: '507f1f77bcf86cd799439011',
    slug: 'fallback-theme',
    songTitle: 'Fallback Song',
    animeTitle: 'Fallback Anime',
    animeSeason: served.season,
    animeSeasonYear: served.year,
    type: 'OP',
    sequence: 1,
    totalWatches: 5,
    isPopular: false,
    popularRank: null,
  };
  const popularDoc = {
    ...fallbackDoc,
    _id: '507f1f77bcf86cd799439022',
    slug: 'popular-theme',
    isPopular: true,
    popularRank: 1,
  };

  const themeModel = {
    find: (filter: Record<string, unknown>) => {
      if ('isPopular' in filter) return queryOf([popularDoc]);
      if (
        filter.animeSeason === served.season &&
        filter.animeSeasonYear === served.year
      ) {
        return queryOf([fallbackDoc]);
      }
      return queryOf([]);
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ThemesController],
      providers: [
        ThemesService,
        { provide: getModelToken(ThemeCache.name), useValue: themeModel },
        { provide: getModelToken(AnimeCache.name), useValue: {} },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the previous season under its true label', async () => {
    const res = await request(app.getHttpServer()).get('/home').expect(200);
    expect(res.body.season).toEqual(served);
    expect(res.body.seasonRail).toHaveLength(1);
    expect(res.body.seasonRail[0].slug).toBe('fallback-theme');
    expect(res.body.popular).toHaveLength(1);
    expect(res.body.popular[0].slug).toBe('popular-theme');
  });
});
