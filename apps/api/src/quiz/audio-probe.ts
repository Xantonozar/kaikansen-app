import { Injectable, Optional } from '@nestjs/common';

/**
 * Audio availability probe (quiz total solution, part 7,
 * 2026-11-11) — the verified-dealing check: does the audio URL
 * the API is about to serve for a quiz question actually exist?
 *
 * Why it exists: the question audio address is DERIVED by
 * pattern from the theme's video link (themes/audio-url.ts).
 * For a small class of themes (~3% — Kokkoku OP1 is the field
 * case) AnimeThemes hosts no .ogg twin, so the derived address
 * is a genuine 404: the client burns its first candidate
 * instantly and falls back to a 40–60 MB video whose audio
 * needs 10–17 s to start. Dealing only verified songs removes
 * that species at the source (solo-quiz.service draw path).
 *
 * The probe is deliberately a yes/no question, never a
 * download: a GET with a small Range header (AnimeThemes
 * answers HEAD with 403, so HEAD cannot be used). 404 is the
 * ONLY verdict that means "missing" — any other outcome
 * (200/206 = exists; timeouts, network errors, 5xx, aborts)
 * is 'unknown', and the dealer KEEPS the song on 'unknown':
 * only certainty replaces. Verdicts are cached in memory
 * (below), so a warm game pays ~0 fresh probes.
 */

export type AudioProbeResult =
  /** The file exists (HTTP 200 or 206 to the ranged GET). */
  | 'ok'
  /** The file provably does not exist (HTTP 404). */
  | 'missing'
  /** No certain answer (timeout / network / other status). */
  | 'unknown';

export interface AudioProbe {
  /**
   * Probe `url`, giving up within `timeoutMs`. Implementations
   * must resolve 'unknown' rather than throw or hang past the
   * timeout — the dealer treats every doubt as "keep the song".
   */
  probe(url: string, timeoutMs: number): Promise<AudioProbeResult>;
}

/**
 * How long a verdict is remembered. The catalogue's twins are
 * effectively static (a hosted .ogg does not appear/disappear
 * day to day), so a day is a safe, conservative lifetime; the
 * cache is in-memory only (the shared database is never written
 * by this feature), so an API restart simply re-warms it.
 */
export const AUDIO_PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The probe range: the smallest slice that proves existence. */
const PROBE_RANGE_HEADER = 'bytes=0-1023';

@Injectable()
export class HttpAudioProbe implements AudioProbe {
  private readonly cache = new Map<
    string,
    { result: 'ok' | 'missing'; expiresAt: number }
  >();

  constructor(
    // @Optional: DI has no Number provider — it injects
    // undefined and the default TTL applies. Tests construct
    // the probe directly with an explicit TTL.
    @Optional()
    private readonly ttlMs: number = AUDIO_PROBE_CACHE_TTL_MS,
  ) {}

  async probe(url: string, timeoutMs: number): Promise<AudioProbeResult> {
    const cached = this.cache.get(url);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.result;
      this.cache.delete(url);
    }
    const result = await this.fetchVerdict(url, Math.max(1, timeoutMs));
    if (result !== 'unknown') {
      this.cache.set(url, {
        result,
        expiresAt: Date.now() + this.ttlMs,
      });
    }
    return result;
  }

  private async fetchVerdict(
    url: string,
    timeoutMs: number,
  ): Promise<AudioProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: PROBE_RANGE_HEADER },
        signal: controller.signal,
      });
      // Only the status was ever wanted — release the body so
      // the connection is freed immediately.
      try {
        await res.body?.cancel();
      } catch {
        // Body already settled — nothing to release.
      }
      if (res.status === 404) return 'missing';
      if (res.status === 200 || res.status === 206) return 'ok';
      return 'unknown';
    } catch {
      // Timeout (abort), DNS, connection reset — all doubt.
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cached verdict count — diagnostics/tests only. */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/**
 * The no-op probe: every song is 'unknown', so the dealer keeps
 * everything — exactly the pre-part-7 behaviour. Used when no
 * real probe was injected (model-less boots, unit tests that
 * construct the service directly), which also guarantees those
 * paths never touch the network.
 */
export const UNKNOWN_AUDIO_PROBE: AudioProbe = {
  async probe(): Promise<AudioProbeResult> {
    return 'unknown';
  },
};
