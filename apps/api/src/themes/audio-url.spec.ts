import { deriveAudioUrl, resolveAudioUrl } from './audio-url';

describe('deriveAudioUrl — the .ogg twin rule', () => {
  it('derives the audio-host .ogg for an AnimeThemes video URL', () => {
    expect(
      deriveAudioUrl('https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm'),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('keeps suffixed file names intact (versions, NCBD rips)', () => {
    expect(
      deriveAudioUrl('https://v.animethemes.moe/JujutsuKaisen-OP1v3.webm'),
    ).toBe('https://a.animethemes.moe/JujutsuKaisen-OP1v3.ogg');
    expect(
      deriveAudioUrl('https://v.animethemes.moe/SamuraiChamploo-ED1-NCBD1080.webm'),
    ).toBe('https://a.animethemes.moe/SamuraiChamploo-ED1-NCBD1080.ogg');
  });

  it('returns null for a non-AnimeThemes host', () => {
    expect(deriveAudioUrl('https://example.com/theme.webm')).toBeNull();
    expect(deriveAudioUrl('https://video/theme.webm')).toBeNull();
    // The audio host itself is not a video source.
    expect(
      deriveAudioUrl('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg'),
    ).toBeNull();
  });

  it('returns null for the right host with the wrong shape', () => {
    // http, not https.
    expect(
      deriveAudioUrl('http://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm'),
    ).toBeNull();
    // Not a .webm file.
    expect(
      deriveAudioUrl('https://v.animethemes.moe/NeonGenesisEvangelion-OP1.mp4'),
    ).toBeNull();
    // Empty file name.
    expect(deriveAudioUrl('https://v.animethemes.moe/.webm')).toBeNull();
    // Query strings are outside the verified pattern.
    expect(
      deriveAudioUrl('https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm?x=1'),
    ).toBeNull();
  });

  it('returns null for missing video URLs', () => {
    expect(deriveAudioUrl(null)).toBeNull();
    expect(deriveAudioUrl(undefined)).toBeNull();
    expect(deriveAudioUrl('')).toBeNull();
  });
});

describe('resolveAudioUrl — the derived .ogg wins (owner doctrine)', () => {
  // Owner ruling, 2026-11-10: this block deliberately REPLACES the
  // original "stored data always wins" doctrine (whose test kept a
  // stored video link verbatim as audio). The seed stored video
  // links in audioUrl slots for a whole class of themes, which left
  // the quiz serving a .webm as its audio — or nothing playable at
  // all. Now: derivation first, a stored value only when nothing
  // derives and it is a genuine audio link.

  it('resolves to the derived .ogg when the stored audioUrl is the video link itself', () => {
    expect(
      resolveAudioUrl(
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('resolves to the derived .ogg when the stored audioUrl is another video link (the lowest-res entry link)', () => {
    expect(
      resolveAudioUrl(
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1v2.webm',
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('prefers the derived .ogg even over a stored REAL audio URL', () => {
    expect(
      resolveAudioUrl(
        'https://cdn.example.com/audio.ogg',
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('derives when the stored audioUrl is null', () => {
    expect(
      resolveAudioUrl(
        null,
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('honours a stored real audio URL when no video link derives', () => {
    expect(
      resolveAudioUrl('https://cdn.example.com/audio.ogg', null),
    ).toBe('https://cdn.example.com/audio.ogg');
    // A video URL on an unverified host derives nothing, so the
    // stored audio stands.
    expect(
      resolveAudioUrl(
        'https://cdn.example.com/audio.ogg',
        'https://example.com/theme.webm',
      ),
    ).toBe('https://cdn.example.com/audio.ogg');
  });

  it('returns null when the stored audioUrl is a video link and nothing derives', () => {
    // The stored value equals the video URL (a non-AnimeThemes pair).
    expect(
      resolveAudioUrl(
        'https://video.example.com/main.webm',
        'https://video.example.com/main.webm',
      ),
    ).toBeNull();
    // A .webm stored value is a video link even on an "audio" host.
    expect(
      resolveAudioUrl(
        'https://audio.example.com/main.webm',
        'https://video.example.com/main.webm',
      ),
    ).toBeNull();
  });

  it('stays null when there is nothing to derive from', () => {
    expect(resolveAudioUrl(null, null)).toBeNull();
    expect(resolveAudioUrl(null, 'https://example.com/theme.webm')).toBeNull();
    expect(resolveAudioUrl(undefined, undefined)).toBeNull();
  });
});
