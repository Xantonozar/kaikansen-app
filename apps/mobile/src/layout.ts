import { useWindowDimensions } from 'react-native';

/**
 * Responsive layout constants for the compact design pass (approved
 * mockup v1). Content columns cap at these widths and centre on wide
 * viewports (web / large devices); on phones they are inert because
 * the window is narrower than the cap.
 */
export const CONTENT_MAX_WIDTH = 720;
export const FORM_MAX_WIDTH = 480;

/** Poster-card width for rails/grids: ~35% of the window, clamped. */
export function usePosterCardWidth(): number {
  const { width } = useWindowDimensions();
  return Math.round(Math.min(168, Math.max(120, width * 0.35)));
}
