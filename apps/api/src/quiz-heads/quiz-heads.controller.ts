import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import {
  isValidHeadFileName,
  parseRangeHeader,
  QuizHeadCacheService,
} from './quiz-heads.service';

/**
 * Phase 2 head cache (2026-11-12) — GET /quiz-heads/:file
 * serves the first 1.5 MB of a quiz song from the API's own
 * disk (see QuizHeadCacheService for the cache itself).
 *
 * Deliberate shape:
 * - PUBLIC (no auth): the bytes are a prefix of a public
 *   catalogue file, and the consumers — the phone's slice
 *   downloader and its audio player — cannot attach the app's
 *   bearer token to a media fetch. The abuse surface is a
 *   rate limit (below) plus the fixed name space: only real
 *   AnimeThemes .ogg names are ever served, the origin is
 *   hard-coded in the service, and a name the origin 404s is
 *   a 404 here too. This is a cache, never a proxy.
 * - FILL-THEN-SERVE: a miss awaits the (deduplicated) origin
 *   fill, then streams from disk. Streaming the origin through
 *   while storing was rejected: a Range request against a
 *   half-filled file is a correctness trap (the range may not
 *   exist yet), and the two real consumers are prefetch-shaped
 *   anyway — the slice download runs a question ahead, Q1's
 *   player mounts behind the setup window, and warming at
 *   deal time means most requests are plain hits.
 * - Range-correct from disk: single-range 206 with
 *   Content-Range, 416 for an impossible range, whole-head
 *   200 otherwise (the players and the resumable downloader
 *   both speak ranges; the http layer's compression never
 *   touches non-JSON, so bytes stay exact).
 * - The Cache-Control is set by hand and WINS over the global
 *   policy interceptor (which leaves this route unclassified
 *   anyway): a file name's bytes never change, so a day of
 *   freshness is honest.
 */
@ApiTags('quiz-heads')
@Controller('quiz-heads')
@UseGuards(ThrottlerGuard)
export class QuizHeadsController {
  constructor(private readonly heads: QuizHeadCacheService) {}

  @Get(':file')
  @Throttle({ 'quiz-heads': { limit: 300, ttl: 60_000 } })
  @ApiOkResponse({
    description:
      'The cached first 1.5 MB of an AnimeThemes quiz song (audio/ogg, range-capable). 404 when the origin has no such file.',
  })
  async getHead(
    @Param('file') file: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!isValidHeadFileName(file)) {
      throw new BadRequestException('Invalid quiz head file name');
    }
    const entry = await this.heads.ensureHead(file);
    if (!entry) {
      throw new NotFoundException('Quiz head unavailable');
    }
    const range = parseRangeHeader(req.headers.range, entry.size);
    if (range === 'unsatisfiable') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${entry.size}`);
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : entry.size - 1;
    res.status(range ? 206 : 200);
    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', String(end - start + 1));
    if (range) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.size}`);
    }
    const stream = createReadStream(entry.path, { start, end });
    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  }
}
