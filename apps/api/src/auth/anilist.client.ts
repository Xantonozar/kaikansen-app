import { Injectable } from '@nestjs/common';

/** The three AniList app credentials, resolved from env by AuthService. */
export interface AnilistConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Result of the code exchange — the fields of AniList's token response we use. */
export interface AnilistTokenResult {
  accessToken?: string;
  error?: string;
  message?: string;
}

/** The AniList viewer profile — exactly the fields the web's query asks for. */
export interface AnilistViewer {
  id: number;
  name: string;
  avatar?: { large?: string } | null;
}

const TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const GRAPHQL_URL = 'https://graphql.anilist.co';

/** The web's Viewer query, verbatim (app/api/auth/anilist/callback). */
const VIEWER_QUERY = `
  query {
    Viewer {
      id
      name
      avatar {
        large
      }
    }
  }
`;

/**
 * Thin injectable wrapper over AniList's two HTTP calls (token exchange
 * + Viewer query), mirroring the web callback's requests exactly:
 * JSON bodies, `Accept: application/json`, code exchanged server-side
 * so the client secret never reaches a device. Kept behind a class so
 * tests can mock it — no test ever touches the live AniList API.
 * Transport/parse failures throw; the caller maps them to the web's
 * 'Internal server error', as the web's own catch-all does.
 */
@Injectable()
export class AnilistClient {
  async exchangeCode(
    config: AnilistConfig,
    code: string,
  ): Promise<AnilistTokenResult> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code,
      }),
    });
    const data = (await res.json()) as Record<string, unknown> | null;
    return {
      accessToken:
        typeof data?.access_token === 'string' ? data.access_token : undefined,
      error: typeof data?.error === 'string' ? data.error : undefined,
      message: typeof data?.message === 'string' ? data.message : undefined,
    };
  }

  async fetchViewer(accessToken: string): Promise<AnilistViewer | null> {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
    });
    const data = (await res.json()) as {
      data?: { Viewer?: AnilistViewer };
    } | null;
    return data?.data?.Viewer ?? null;
  }
}
