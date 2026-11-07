/**
 * Kaikansen design tokens — from specs/DESIGN.md (Gate 4 PASSED 2026-11-07).
 *
 * Dark is the default and reference theme (Gate 4 decision). The light token
 * set ships in full as data; the Settings toggle (Slice 2, theme-context.tsx)
 * switches between the two sets at runtime.
 *
 * Sources: DESIGN.md §2 (colour), §3 (typography, values = proposal P-03),
 * §4 (radius = source; spacing = proposal P-04). Tokens marked P-01/P-02 are
 * the adopted Gate 4 proposals filling values the website does not evidence.
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
}

export const darkTheme: Theme = {
  background: '#120A0E',
  surface: '#1E0E15', // P-01
  raised: '#29141D', // P-01
  accent: '#D63D7A',
  accentContainer: '#1E0E15', // P-01 — surface doubles as accent container (as in light)
  onAccent: '#FFD1E3',
  onAccentContainer: '#FFD1E3',
  secondary: '#D77FB0', // P-01
  tertiary: '#8B89E8', // P-01 (ED)
  text: '#F7E8EE', // P-01
  muted: '#B98A9C', // P-01
  border: '#3A1E2A', // P-01
  wordmark: '#BE185D', // P-13 — shared wordmark colour, kept in dark
};

export const lightTheme: Theme = {
  background: '#FDE7ED',
  surface: '#FBE0E7',
  // The source defines no separate raised surface for light; it reuses surface.
  raised: '#FBE0E7',
  accent: '#B02A69',
  accentContainer: '#FBE0E7',
  onAccent: '#FFFFFF', // P-02
  onAccentContainer: '#B02A69',
  secondary: '#B65397',
  tertiary: '#6C6BD4', // ED
  text: '#2D1420',
  muted: '#8A5A6E', // P-02
  border: '#F3CBD9', // P-02
  wordmark: '#BE185D',
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
  card: 20,
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
  headerHeight: 64,
  tabBarHeight: 64,
} as const;
