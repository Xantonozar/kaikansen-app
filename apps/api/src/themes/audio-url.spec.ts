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

describe('resolveAudioUrl — stored wins, derivation fills the gap', () => {
  it('keeps a stored audioUrl verbatim (never overwritten)', () => {
    expect(
      resolveAudioUrl(
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm');
    expect(
      resolveAudioUrl('https://cdn.example.com/audio.ogg', null),
    ).toBe('https://cdn.example.com/audio.ogg');
  });

  it('derives when the stored audioUrl is null', () => {
    expect(
      resolveAudioUrl(
        null,
        'https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm',
      ),
    ).toBe('https://a.animethemes.moe/NeonGenesisEvangelion-OP1.ogg');
  });

  it('stays null when there is nothing to derive from', () => {
    expect(resolveAudioUrl(null, null)).toBeNull();
    expect(resolveAudioUrl(null, 'https://example.com/theme.webm')).toBeNull();
    expect(resolveAudioUrl(undefined, undefined)).toBeNull();
  });
});
