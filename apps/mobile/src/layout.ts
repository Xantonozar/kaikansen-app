import { useWindowDimensions } from 'react-native';

/**
 * Responsive layout constants for the compact design pass (approved
 * mockup v1). Content columns cap at these widths and centre on wide
 * viewports (web / large devices); on phones they are inert because
 * the window is narrower than the cap.
 */
export const CONTENT_MAX_WIDTH = 720;
export const FORM_MAX_WIDTH = 480;

/**
 * Poster-card width for the Home season rail: the Lavender Dusk
 * Home mock's cards measure ≈315px of the 780px-wide mock — ≈40% of
 * the window (layout-fidelity design pass, measured from
 * kaikansen-home-v3-realimg.png) — clamped to stay sane off-phone.
 * The rendered width is that size ×1.3 (owner's order, 2026-11-10);
 * the card's height follows through its fixed aspect ratio.
 */
export function usePosterCardWidth(): number {
  const { width } = useWindowDimensions();
  return Math.round(Math.min(176, Math.max(132, width * 0.4)) * 1.3);
}
