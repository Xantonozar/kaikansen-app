import { Injectable } from '@nestjs/common';
import { ANIME_INCLUDE, AT_BASE, AT_USER_AGENT } from './sync.constants';
import type { AtAnime } from './sync.types';

/**
 * Thin injectable wrapper over the AnimeThemes API, ported from
 * `fetchATResourcePage` in the web's `scripts/seed-utils.ts`: same base
 * URL, same `User-Agent: Kaikansen/1.0.0` header, same page shape
 * (page[size]=100). Transport/HTTP failures THROW, exactly as the web's
 * helper does — the job runner owns the retry/skip policy. Kept behind a
 * class so tests mock it; no test touches the live API.
 */
@Injectable()
export class AnimeThemesClient {
  /** One page of the `anime` resource — the sync engine's paging source. */
  async fetchAnimePage(
    page: number,
    apiFilter?: string,
  ): Promise<{ anime?: AtAnime[] }> {
    return this.fetchResourcePage('anime', page, ANIME_INCLUDE, apiFilter);
  }

  async fetchResourcePage(
    resource: string,
    page: number,
    include: string,
    apiFilter?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    let url = `${AT_BASE}/${resource}?page[size]=100&page[number]=${page}&include=${include}`;
    if (apiFilter) url += `&${apiFilter}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': AT_USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`AT ${resource} page ${page} → HTTP ${res.status}`);
    }
    return res.json();
  }
}
