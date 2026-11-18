import type {
  CreateSoloGameRequest,
  QuizGuessType,
  QuizLeaderboardResponse,
  SoloAnswerResponse,
  SoloGameState,
  SoloPlaybackStartedResponse,
  SoloReplaceResponse,
} from '@kaikansen/contracts';
import { apiJson, fixtureMode } from './api';
import { getAccessToken } from './session';

/**
 * Solo quiz client (Slice M4) — the S4 REST surface:
 *
 * - POST /quiz/solo/games               create a 10-question game
 * - GET  /quiz/solo/games/:gameId       the live game state
 * - POST /quiz/solo/games/:gameId/playback-started  signal the question's audio actually started (or proved unplayable) — the answer window opens there
 * - POST /quiz/solo/games/:gameId/answers  answer (null = skip/timeout)
 * - POST /quiz/solo/games/:gameId/replace-failed  swap the live question for a spare theme when its theme could not be played at all (owner order, 2026-11-16)
 * - GET  /quiz/leaderboard              public top-10 attempts board
 *
 * over the authenticated fetch in api.ts (the 401-refresh dance lives
 * there; apiJson surfaces the API's own error message). Games are
 * server-held and scored server-side — the client only ever sends the
 * chosen option verbatim, exactly as the contracts describe.
 *
 * FIXTURE MODE: there is no API to play against, so the leaderboard
 * resolves the honest empty board and game calls reject with a
 * demo-mode message the UI can surface verbatim — no fake games.
 * A game call attempted signed-out likewise rejects with a sign-in
 * message instead of leaking a bare 401 to the UI.
 */

const DEMO_MESSAGE =
  'Quiz is not available in demo mode — connect the app to the API to play.';
const SIGN_IN_MESSAGE = 'Log in to play the quiz.';

function guardPlay(): void {
  if (fixtureMode) throw new Error(DEMO_MESSAGE);
  if (!getAccessToken()) throw new Error(SIGN_IN_MESSAGE);
}

export async function createSoloGame(
  body: CreateSoloGameRequest,
): Promise<SoloGameState> {
  guardPlay();
  return apiJson<SoloGameState>('/quiz/solo/games', {
    method: 'POST',
    body,
  });
}

export async function fetchSoloGame(gameId: string): Promise<SoloGameState> {
  guardPlay();
  return apiJson<SoloGameState>(
    `/quiz/solo/games/${encodeURIComponent(gameId)}`,
  );
}

/**
 * Signal that the live question's media wait ended — the audio
 * actually started playing, or every candidate failed (owner
 * timing fix, 2026-11-10). The server stamps its own clock; the
 * answer measurement opens at draw + the credited load. Callers
 * fire this once per question and may ignore failures: without
 * the signal the server measures from the draw, as before.
 *
 * `index` + `slug` name the exact question the signal belongs
 * to (audit fix, 2026-11-16): the signal races the spare-theme
 * swap — both fire when a theme fails — and a signal landing
 * after the swap must not stamp the replacement as started (the
 * swap keeps the slot index, so the theme slug is the identity
 * that actually changes). The server ignores the stamp on a
 * mismatch; older servers ignore the body.
 */
export async function markSoloPlaybackStarted(
  gameId: string,
  index?: number,
  slug?: string,
): Promise<SoloPlaybackStartedResponse> {
  guardPlay();
  return apiJson<SoloPlaybackStartedResponse>(
    `/quiz/solo/games/${encodeURIComponent(gameId)}/playback-started`,
    { method: 'POST', body: { index, slug } },
  );
}

/** `answer` is the chosen option verbatim; null = skip / timer expired. */
export async function submitSoloAnswer(
  gameId: string,
  answer: string | null,
): Promise<SoloAnswerResponse> {
  guardPlay();
  return apiJson<SoloAnswerResponse>(
    `/quiz/solo/games/${encodeURIComponent(gameId)}/answers`,
    { method: 'POST', body: { answer } satisfies { answer: string | null } },
  );
}

/**
 * Swap the live question for one of the game's spare themes
 * (owner order, 2026-11-16): the question's whole candidate
 * chain failed, so instead of burning the question the server
 * deals a replacement into the same slot — no attempt is
 * recorded and score/streak are untouched. Rejects when the
 * game is finished or the spares are spent; the caller then
 * keeps the failed question (answerable without audio, the
 * pre-spare behaviour).
 *
 * `slug` names the failed theme (audit round 2, 2026-11-16):
 * it makes the swap idempotent server-side — a replayed call
 * whose slug no longer matches the live question returns the
 * live question without spending another spare.
 */
export async function replaceSoloQuestion(
  gameId: string,
  slug?: string,
): Promise<SoloReplaceResponse> {
  guardPlay();
  return apiJson<SoloReplaceResponse>(
    `/quiz/solo/games/${encodeURIComponent(gameId)}/replace-failed`,
    { method: 'POST', body: { slug } },
  );
}

/** Public board — readable signed-out too; fixture mode is honestly empty. */
export async function fetchQuizLeaderboard(
  type?: QuizGuessType,
): Promise<QuizLeaderboardResponse> {
  if (fixtureMode) return { entries: [] };
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return apiJson<QuizLeaderboardResponse>(`/quiz/leaderboard${query}`);
}
