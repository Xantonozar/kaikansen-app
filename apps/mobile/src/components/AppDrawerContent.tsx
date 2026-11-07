import { Fragment, useMemo, type ComponentType, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from 'expo-router/drawer';
import { usePathname, useRouter, type Href } from 'expo-router';
import {
  Check,
  ChevronRight,
  House,
  Library,
  Link2,
  LogIn,
  LogOut,
  Moon,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trophy,
  User,
} from 'lucide-react-native';
import { fontFamilies, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme, useThemeMode } from '../theme-context';
import { useAuth } from '../auth';
import { useAnilistLink } from '../hooks/useAnilistLink';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

type TabName = 'index' | 'quiz' | 'social' | 'library';

/** Tab route name → href + label + icon (icons mirror TabBar, P-08). */
const TAB_ITEMS: Record<
  TabName,
  { href: Href; label: string; Icon: IconComponent }
> = {
  index: { href: '/(drawer)/(tabs)', label: 'Home', Icon: House },
  quiz: { href: '/(drawer)/(tabs)/quiz', label: 'Quiz', Icon: Trophy },
  social: { href: '/(drawer)/(tabs)/social', label: 'Social', Icon: User },
  library: { href: '/(drawer)/(tabs)/library', label: 'Library', Icon: Library },
};

const TAB_ORDER: TabName[] = ['index', 'quiz', 'social', 'library'];

/** Pathname (groups stripped) → the tab it belongs to. */
function activeTab(pathname: string): TabName | null {
  switch (pathname) {
    case '/':
      return 'index';
    case '/quiz':
      return 'quiz';
    case '/social':
      return 'social';
    case '/library':
      return 'library';
    default:
      return null;
  }
}

interface DrawerItemRowProps {
  Icon: IconComponent;
  label: string;
  accessibilityLabel: string;
  active?: boolean;
  busy?: boolean;
  trailing?: ReactNode;
  onPress: () => void;
}

/**
 * Compact, icon-led sidebar content. The profile collapses to one row,
 * destinations are short labelled icon tiles, and account utilities sit
 * at the bottom. AniList uses the shared Settings hook, so its action,
 * busy state, and feedback wording remain unchanged.
 */
export function AppDrawerContent({
  navigation,
}: DrawerContentComponentProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { status, user, logout } = useAuth();
  const { anilistUsername, linkBusy, linkNote, linkError, startLink } =
    useAnilistLink();
  const router = useRouter();
  const pathname = usePathname();

  const signedIn = status === 'signedIn' && user !== null;
  const currentTab = activeTab(pathname);

  /** Navigate, then close the drawer. */
  const go = (href: Href) => {
    router.navigate(href);
    navigation.closeDrawer();
  };

  const onLogout = async () => {
    await logout();
    go(TAB_ITEMS.index.href);
  };

  const item = ({
    Icon,
    label,
    accessibilityLabel,
    active,
    busy,
    trailing,
    onPress,
  }: DrawerItemRowProps) => (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!active, busy: !!busy }}
      style={[styles.item, active && styles.itemActive]}
    >
      <View style={[styles.iconSlot, active && styles.iconSlotActive]}>
        <Icon
          size={20}
          color={active ? theme.accent : theme.muted}
          strokeWidth={2}
        />
      </View>
      <Text
        numberOfLines={1}
        style={[styles.itemLabel, active && styles.itemLabelActive]}
      >
        {label}
      </Text>
      {trailing}
      {busy && <ActivityIndicator color={theme.accent} />}
    </Pressable>
  );

  return (
    <DrawerContentScrollView contentContainerStyle={styles.panel}>
      {signedIn ? (
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>
              {(user.displayName || user.username).charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.profileName} numberOfLines={1}>
            {user.displayName || user.username}
          </Text>
        </View>
      ) : (
        item({
          Icon: LogIn,
          label: 'Log in',
          accessibilityLabel: 'Log in',
          onPress: () => go('/login'),
        })
      )}

      <View style={styles.navigation}>
        {TAB_ORDER.map((name) => {
          const tab = TAB_ITEMS[name];
          return (
            <Fragment key={name}>
              {item({
                Icon: tab.Icon,
                label: tab.label,
                accessibilityLabel: `Go to ${tab.label}`,
                active: currentTab === name,
                onPress: () => go(tab.href),
              })}
            </Fragment>
          );
        })}
        {item({
          Icon: Search,
          label: 'Search',
          accessibilityLabel: 'Go to Search',
          active: pathname === '/search',
          onPress: () => go('/search'),
        })}
        {item({
          Icon: SettingsIcon,
          label: 'Settings',
          accessibilityLabel: 'Go to Settings',
          active: pathname === '/settings',
          onPress: () => go('/settings'),
        })}
      </View>

      <View style={styles.spacer} />

      <View style={styles.utilities}>
        {signedIn &&
          (anilistUsername ? (
            <View
              style={styles.item}
              accessible
              accessibilityLabel={`AniList linked as ${anilistUsername}`}
            >
              <View style={styles.iconSlot}>
                <Link2 size={20} color={theme.muted} strokeWidth={2} />
              </View>
              <Text numberOfLines={1} style={styles.itemLabel}>
                AniList
              </Text>
              <Check size={18} color={theme.accent} strokeWidth={2.5} />
            </View>
          ) : (
            item({
              Icon: Link2,
              label: 'AniList',
              accessibilityLabel: 'Link AniList account',
              busy: linkBusy,
              trailing: linkBusy ? undefined : (
                <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
              ),
              onPress: () => void startLink(),
            })
          ))}

        {signedIn && (linkNote !== null || linkError !== null) && (
          <Text style={linkError !== null ? styles.error : styles.feedback}>
            {linkError ?? linkNote}
          </Text>
        )}

        {item({
          Icon: mode === 'dark' ? Moon : Sun,
          label: mode === 'dark' ? 'Dark' : 'Light',
          accessibilityLabel:
            mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
          onPress: () => setMode(mode === 'dark' ? 'light' : 'dark'),
        })}

        {signedIn &&
          item({
            Icon: LogOut,
            label: 'Log out',
            accessibilityLabel: 'Log out',
            onPress: () => void onLogout(),
          })}
      </View>
    </DrawerContentScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    panel: {
      flexGrow: 1,
    },
    profile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 56,
      marginBottom: spacing.lg,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: 14,
      backgroundColor: theme.surface,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    avatarInitial: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    profileName: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      flex: 1,
    },
    navigation: {
      gap: spacing.xs,
    },
    spacer: {
      flex: 1,
      minHeight: spacing.xl,
    },
    utilities: {
      gap: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: spacing.sm,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: 14,
    },
    itemActive: {
      backgroundColor: theme.accentContainer,
    },
    iconSlot: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    iconSlotActive: {
      backgroundColor: withOpacity(theme.accent, 0.16),
    },
    itemLabel: {
      ...typeStyles.body,
      color: theme.text,
      flex: 1,
    },
    itemLabelActive: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    feedback: {
      ...typeStyles.caption,
      color: theme.muted,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      lineHeight: 16,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      lineHeight: 16,
    },
  });
