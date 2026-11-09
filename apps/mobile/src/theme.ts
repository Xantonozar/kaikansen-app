/**
 * Kaikansen design tokens — Lavender Dusk reskin (owner decision 2026-11-09).
 *
 * The colour sets below supersede the Gate 4 pink palette. Source of truth:
 * specs/LAVENDER-DUSK-HANDOFF.md — values measured from the 38 approved
 * Lavender Dusk design screens. Light is now the default and reference
 * theme (every approved screen is light); the dark set ("Lavender Night")
 * is derived from the same family so the Settings toggle keeps working.
 *
 * Typography (§3), radius and spacing (§4) are unchanged from Gate 4.
 */

export interface Theme {
  background: string;
  surface: string;
  raised: string;
  accent: string;
  accentContainer: string;
  onAccent: string;
  onAccentContainer: string;
  secondary: string;
  tertiary: string;
  text: string;
  muted: string;
  border: string;
  wordmark: string;
  success: string;
  successContainer: string;
  danger: string;
  dangerContainer: string;
}

export const lightTheme: Theme = {
  background: '#F7F2F7', // Lavender Dusk page background (measured)
  surface: '#FFFEFF', // card white (measured)
  raised: '#EDE3F2', // disc lavender — raised discs/avatars (measured)
  accent: '#6E4158', // mauveDeep — primary buttons, active nav pill (measured)
  accentContainer: '#F3ECF6', // lavenderChip — chips, icon discs (measured)
  onAccent: '#FFFFFF',
  onAccentContainer: '#6E4158',
  secondary: '#8E5B7B', // mauve — icons, hearts, progress (measured)
  tertiary: '#8E5B7B', // ED — same family as OP per the approved mocks
  text: '#2D2329', // warm plum-brown ink (measured)
  muted: '#7B6776', // measured
  border: '#E7DCEA', // soft lavender hairline (derived from disc lavender)
  wordmark: '#6E4158',
  success: '#2D6A4F', // sage — correct answers, connected states (measured)
  successContainer: '#EBF5EE', // sageTint (measured)
  danger: '#B3261E', // destructive (Log Out, wrong pick) — family-adjusted
  dangerContainer: '#F9E9E7',
};

export const darkTheme: Theme = {
  // "Lavender Night" — derived dark counterpart of Lavender Dusk (no
  // approved dark screens exist; derived 2026-11-09 to keep the toggle peer).
  background: '#171017',
  surface: '#241722',
  raised: '#2E1D2C',
  accent: '#C79BB4',
  accentContainer: '#33202F',
  onAccent: '#241118',
  onAccentContainer: '#E3BFD3',
  secondary: '#B983A3',
  tertiary: '#B983A3',
  text: '#F3EAF2',
  muted: '#B49BA9',
  border: '#3A2836',
  wordmark: '#C79BB4',
  success: '#7FB894',
  successContainer: '#1E2B23',
  danger: '#E89A94',
  dangerContainer: '#33201F',
};

/**
 * Components read the ACTIVE set through useTheme() (theme-context.tsx)
 * — Slice 2 wired the Settings toggle, so nothing may import a static
 * token set for styling. `withOpacity` derives translucent variants
 * (the header scrim, P-06) from whichever set is active.
 */
export function withOpacity(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Radius scale — DESIGN.md §4 (source values). Pills are fully rounded. */
export const radii = {
  sm: 8,
  base: 12,
  md: 16,
  // Cards sit at the Lavender Dusk mocks' measured ~24 (design
  // polish pass — the fidelity audit measured the app's rows at
  // 20 against the mocks' 24).
  card: 24,
  cardLg: 24,
  pill: 999,
} as const;

/** Spacing scale — DESIGN.md §4 (proposal P-04; the source has no values). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  screenEdge: 16,
} as const;

/**
 * Loaded font faces (expo-font, see app/_layout.tsx). The wordmark face is
 * Outfit 800 with an italic style applied at use site: @expo-google-fonts/outfit
 * ships no italic cut of Outfit, so the platform synthesises the oblique.
 */
export const fontFamilies = {
  wordmark: 'Outfit_800ExtraBold',
  display: 'Outfit_700Bold',
  heading: 'Outfit_600SemiBold',
  sectionLabel: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  bodyStrong: 'Inter_600SemiBold',
  bodySmall: 'Inter_400Regular',
  caption: 'Inter_500Medium',
  mono: 'JetBrainsMono_500Medium',
} as const;

/** Type scale — DESIGN.md §3 (families are source; size/weight map is P-03). */
export const typeStyles = {
  wordmark: { fontFamily: fontFamilies.wordmark, fontSize: 24, fontStyle: 'italic' as const },
  display: { fontFamily: fontFamilies.display, fontSize: 22 },
  heading: { fontFamily: fontFamilies.heading, fontSize: 18 },
  sectionLabel: { fontFamily: fontFamilies.sectionLabel, fontSize: 15 },
  body: { fontFamily: fontFamilies.body, fontSize: 14 },
  bodySmall: { fontFamily: fontFamilies.bodySmall, fontSize: 12 },
  caption: { fontFamily: fontFamilies.caption, fontSize: 11 },
  mono: { fontFamily: fontFamilies.mono, fontSize: 12 },
} as const;

/** Shell dimensions — DESIGN.md §5. */
export const shell = {
  // 56 = the Lavender Dusk mocks' header bar (Home v3 header is
  // h-14), measured in layout-fidelity Slice 6; DESIGN.md §5's 64
  // was the Gate-4 treatment the mocks superseded.
  headerHeight: 56,
  tabBarHeight: 64,
} as const;
