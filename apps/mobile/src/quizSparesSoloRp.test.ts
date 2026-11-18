import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Spare themes + solo RP wiring pins (owner orders, 2026-11-16;
 * no test renders these screens today — the franchise.test.ts
 * source-scan precedent):
 * - a failed/empty question with spares left is SWAPPED, not
 *   burned: the solo screen calls the replace-failed endpoint,
 *   shows the owner's line, and restarts the replacement under
 *   a nonce'd media key (same index — without the nonce the
 *   frozen chain of the failed question would be reused);
 * - answers are held while a swap is in flight, so a ring
 *   expiry mid-swap can't score against the new question;
 * - the game-over answer's rpChange reaches the results rank
 *   card as gainedRp, and the card can draw a LOSS pill too
 *   (solo's under-5 tiers are negative).
 */

const solo = readFileSync(
  join(__dirname, '../app/(drawer)/quiz/solo.tsx'),
  'utf8',
);
const quizApi = readFileSync(join(__dirname, 'quizApi.ts'), 'utf8');
const rankCard = readFileSync(
  join(__dirname, 'components/RankCard.tsx'),
  'utf8',
);

describe('spare-theme replacement wiring', () => {
  it('the client calls the replace-failed endpoint', () => {
    expect(quizApi).toContain('replaceSoloQuestion');
    expect(quizApi).toContain('/replace-failed');
    expect(solo).toContain('replaceSoloQuestion(gameId, failedSlug)');
  });

  it("shows the owner's line while swapping", () => {
    expect(solo).toContain(
      'const REPLACE_NOTICE = "Theme couldn\'t play — trying another one"',
    );
    expect(solo).toContain('setReplaceNotice(REPLACE_NOTICE)');
  });

  it('only swaps on the failed/empty verdict for the live key, with spares left', () => {
    expect(solo).toContain(
      "audioState.phase !== 'failed' && audioState.phase !== 'empty'",
    );
    expect(solo).toContain('if (sparesRemaining <= 0) return;');
    expect(solo).toContain('lastReplaceKeyRef.current === key');
  });

  it('the replacement restarts under a nonce’d media key', () => {
    expect(solo).toContain('nonce: questionNonceRef.current + 1');
    expect(solo).toContain(":r${nonce}");
    expect(solo).toContain('mediaKeyFor(');
  });

  it('submit is held while a swap is in flight', () => {
    expect(solo).toContain('if (replacingRef.current) return;');
  });

  it('the spare count tracks the server’s (create + answers)', () => {
    expect(solo).toContain('setSparesRemaining(state.sparesRemaining ?? 0)');
    expect(solo).toContain('setSparesRemaining(res.sparesRemaining)');
  });
});

describe('audit fixes (2026-11-16)', () => {
  it('the playback-started signal carries the question’s identity (index + slug)', () => {
    expect(solo).toContain('markSoloPlaybackStarted(gid, qIndex, slug)');
    expect(solo).toContain('startClock(question.index, question.theme.slug)');
    expect(solo).toContain('startClock(q.index, q.theme.slug)');
    expect(quizApi).toContain('body: { index, slug }');
  });

  it('a failed swap re-reads the game and adopts a landed replacement', () => {
    expect(solo).toContain('fetchSoloGame(gameId)');
    expect(solo).toContain('state.question.theme.slug !== failedSlug');
    expect(solo).toContain('state.question.index === failedIndex');
  });

  it('the swap names the failed theme, so a replay cannot double-spend (round 2)', () => {
    expect(solo).toContain('replaceSoloQuestion(gameId, failedSlug)');
    expect(quizApi).toContain('body: { slug }');
  });
});

describe('solo RP wiring', () => {
  it('the game-over rpChange reaches the results card as gainedRp', () => {
    expect(solo).toContain('setSoloRpChange(res.rpChange ?? null)');
    expect(solo).toContain('gainedRp={soloRpChange ?? undefined}');
  });

  it('the results card draws a loss pill for a negative change', () => {
    expect(rankCard).toContain('gainedRp != null && gainedRp < 0');
    expect(rankCard).toContain('lossPill');
  });
});
