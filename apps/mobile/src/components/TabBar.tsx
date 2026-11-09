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
 * Bottom navigation (DESIGN.md §5): 64px bar, four tabs. Lavender Dusk
 * treatment (owner decision 2026-11-09, all 38 approved screens): the bar
 * is ICON-ONLY — the active tab's icon sits in a solid mauveDeep pill,
 * inactive tabs are bare icons. Labels survive as accessibility labels.
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
          { paddingBottom: insets.bottom, height: shell.tabBarHeight + insets.bottom },
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
            <View style={[styles.pill, focused && styles.pillActive]}>
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
    backgroundColor: theme.background,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 52, // ≥44px touch target (DESIGN.md §10)
  },
  pill: {
    minWidth: 58,
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: theme.accent,
  },
});
