import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { House, Library, Trophy, Users } from 'lucide-react-native';
import type { ComponentType } from 'react';
import {
  fontFamilies,
  radii,
  shell,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';

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
 * Bottom navigation (DESIGN.md §5): 64px bar, four tabs. Compact
 * treatment (approved mockup v1): the active tab's icon sits in a
 * solid accent pill with the label underneath it (secondary when
 * active, muted otherwise); inactive tabs are bare icon + label.
 */
export function TabBar({ state, navigateToTab, insets }: TabBarProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
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
        const labelColor = focused ? theme.secondary : theme.muted;

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
              <Icon size={20} color={iconColor} strokeWidth={2} />
            </View>
            <Text style={[styles.label, { color: labelColor }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
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
    minWidth: 48,
    height: 28,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: theme.accent,
  },
  label: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
  },
});
