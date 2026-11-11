import { describe, expect, it } from '@jest/globals';
import {
  ABOUT_CREDITS,
  ABOUT_DESCRIPTION,
  ABOUT_LINKS,
  ABOUT_WHATS_NEW,
  aboutVersionLine,
} from './aboutContent';

/**
 * About screen facts (release readiness, 2026-11-11): the screen
 * may only ever show real info — these tests pin the facts the
 * project record backs (real sources, real shipped work, the
 * real links), so a future edit cannot quietly invent content.
 */
describe('about content', () => {
  it('renders the version line from the runtime build facts', () => {
    expect(aboutVersionLine('1.0.0', 2)).toBe('Version 1.0.0 (build 2)');
    expect(aboutVersionLine('0.1.0', 1)).toBe('Version 0.1.0 (build 1)');
  });

  it('describes the app by what it actually does', () => {
    expect(ABOUT_DESCRIPTION).toContain('anime opening & ending themes');
    expect(ABOUT_DESCRIPTION).toContain('quiz');
  });

  it('credits the real data sources and the developer', () => {
    const values = ABOUT_CREDITS.map((c) => c.value).join(' · ');
    expect(values).toContain('AnimeThemes');
    expect(values).toContain('AniList');
    expect(values).toContain('Cloudinary');
    expect(values).toContain('Salman Ahmed Zadid');
  });

  it('links only to the real website and AniList', () => {
    expect(ABOUT_LINKS).toEqual([
      { label: 'Website', url: 'https://kaiseen.vercel.app' },
      { label: 'AniList', url: 'https://anilist.co' },
    ]);
  });

  it("what's new lists shipped 1.0.2 work, nothing speculative", () => {
    const joined = ABOUT_WHATS_NEW.join('\n');
    expect(joined).toContain('Faster cold opens');
    expect(joined).toContain('skeleton loading');
    expect(joined).toContain('remember');
    expect(ABOUT_WHATS_NEW.length).toBeGreaterThanOrEqual(4);
  });
});
