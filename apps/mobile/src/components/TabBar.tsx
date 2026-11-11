import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { House, Library, Trophy, Users } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { radii, shell, spacing, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { MiniPlayer } from './MiniPlayer';

type IconComponent = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/** Route name → tab label + icon (DESIGN.md §5, §9; glyphs per P-08). */
const TABS: Record<string, { label: string; Icon: IconComponent }> = {
  index: { label: 'Home', Icon: House },
  quiz: { label: 'Quiz', Icon: Trophy },
  social: { label: 'Social', Icon: Users },
  library: { label: 'Library', Icon: Library },
};

/**
 * Structural subset of the props Expo Router 58 passes to a custom `tabBar`
 * (its standard-navigation API: state + navigateToTab + insets).
 */
export interface TabBarProps {
  state: {
    index: number;
    routes: { key: string; name: string }[];
  };
  navigateToTab: (routeKey: string) => void;
  insets: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
}

/**
 * Bottom navigation (DESIGN.md §5): four tabs. Lavender Dusk
 * treatment (owner decision 2026-11-09, all 38 approved screens): the bar
 * is ICON-ONLY — the active tab's icon sits in a solid mauveDeep pill,
 * inactive tabs are bare icons. Labels survive as accessibility labels.
 *
 * Design polish pass: the bar FLOATS as the mocks draw it — a
 * white rounded container inset from the screen edges over the
 * page background, not a full-bleed white bar on a hairline. The
 * shell is transparent so the page shows around the float; the
 * bottom inset is halved into the float's margin (the rest of
 * the gesture area stays clear of the container's edge).
 *
 * Font scaling (polish batch, 2026-11-11 — safe subset only):
 * this bar is ICON-ONLY — labels live only in accessibilityLabel,
 * so there is no visible label Text to guard. The guard the
 * batch called for has nothing to attach to here; the fixed
 * 34pt pill holds icons (lucide glyphs do not scale with the
 * system font). Flagged in the batch report, not improvised.
 *
 * Above the bar sits the mini player (layout-fidelity Slice 1): the
 * finalized mocks float it over the page background just above the
 * tab row on every tab screen while a session is playing. It renders
 * nothing when no session is loaded.
 */
export function TabBar({ state, navigateToTab, insets }: TabBarProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.shell}>
      <MiniPlayer placement="tabBar" />
      <View
        style={[
          styles.bar,
          { marginBottom: spacing.sm + Math.round(insets.bottom / 2) },
        ]}
      >
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        const { Icon } = tab;
        const iconColor = focused ? theme.onAccent : theme.muted;

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (!focused) navigateToTab(route.key);
            }}
            style={styles.tab}
          >
            <View style={styles.pill}>
              <View
                style={[styles.pillFill, focused && styles.pillFillActive]}
              />
              <Icon size={22} color={iconColor} strokeWidth={2} />
            </View>
          </Pressable>
        );
      })}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  shell: {
    // Transparent: the floating bar (and the mini player above
    // it) sit over the page background, as the mocks draw them.
    backgroundColor: 'transparent',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: shell.tabBarHeight,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.sm,
    backgroundColor: theme.surface,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    shadowColor: '#2D2329',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 52, // ≥44px touch target (DESIGN.md §10)
  },
  pill: {
    // The pill's SHAPE lives on this view and never changes: fixed
    // size, pill radius, overflow hidden. Do not put the active
    // background colour here — on Android (RN's BackgroundDrawable)
    // a background fill whose colour toggles on re-render can paint
    // through drawRect with the radius dropped, which is exactly the
    // "square pill on second selection" bug this structure prevents:
    // the colour is painted by the dumb inner fill below and this
    // view's rounded clip (clipToPaddingBox) enforces the silhouette
    // no matter how the fill itself is drawn.
    minWidth: 58,
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  pillFillActive: {
    backgroundColor: theme.accent,
  },
});
