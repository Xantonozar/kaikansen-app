import { useMemo } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import {
  CircleArrowDown,
  CloudOff,
  Download,
  House,
  Library,
  RefreshCw,
  Trophy,
  Users,
  WifiOff,
} from 'lucide-react-native';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useConnectivity } from '../connectivity';
import { useDownloads } from '../downloads';
import { savedThemesLabel } from '../offline';
import { AppImage } from './AppImage';

/**
 * Offline screen (owner-approved design 2026-11-11 — Stitch
 * `428a5effb4204195a76d38993f671a53`; measurements from
 * kaikansen-offline-stitch.html, the standing HTML-truth rule).
 *
 * A full-screen takeover rendered by the OfflineGate (in the
 * drawer layout) INSTEAD of the navigator content when the gate
 * decision (src/offline.ts) says the device is definitively
 * offline and the current surface cannot serve: what the user was
 * looking at stays mounted underneath, untouched — reconnect (or a
 * successful Retry re-check) flips the decision and the surface is
 * simply uncovered again, exactly where they were.
 *
 * Everything on it is real: the count chip reads the downloads
 * store at render time (the Downloads screen's own on-device
 * definition — completed records whose file is present; the
 * store's subscription keeps it live if a download settles while
 * the screen is up), "Go to Downloads" pushes the existing
 * Downloads route, Retry re-checks connectivity through
 * NetInfo.fetch (connectivity.tsx). No sync states, no queues, no
 * error text — the design's whole vocabulary.
 *
 * The bottom bar recreates the mock's nav (the real tab shell is
 * what gets covered, drawer overlay included): the four tabs with
 * Library active in the filled mauve pill, per the approved
 * routing — Downloads lives in the Library context. Inactive tabs
 * are honest navigation (they switch to that tab; the gate
 * re-decides there — a cold tab is covered again, a servable one
 * is not). The player route and quiz play are deliberately NOT
 * reachable from here: playback is never interrupted by this
 * screen, and quiz screens keep their own clean design law.
 */

// The brand glyph — the same brush-K splash asset the auth screens
// draw (owner's asset ruling: the latest logo), in the mock's
// white rounded tile.
const GLYPH = require('../../assets/splash-icon.png');

/** HTML colour literals the theme tokens don't carry (see styles). */
const HTML = {
  chipBg: '#EFE4EE',
  chipBorder: '#E6D7E5',
  heroBg: '#F1E4EE',
  heroBorder: '#E9DCE7',
  countBorder: '#E8DEE8',
  inactiveTab: '#9E879B',
  navBg: '#FAF8FC',
  navBorder: '#E5DEE8',
} as const;

export function OfflineScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { retry } = useConnectivity();
  const { records } = useDownloads();
  const savedCount = records.filter((r) => !r.fileMissing).length;

  // Library is the mock's active tab here; if the takeover ever
  // covers a screen while ANOTHER tab is focused (a pushed screen
  // over Quiz, say), the pill follows the tab the user is actually
  // in — the mock's Library-active is the Library-context case.
  const activeTab = pathname.startsWith('/quiz')
    ? 'quiz'
    : pathname.startsWith('/social')
      ? 'social'
      : pathname === '/'
        ? 'index'
        : 'library';

  const goTab = (tab: 'index' | 'quiz' | 'social' | 'library') => {
    if (tab === activeTab) return;
    router.navigate(tab === 'index' ? '/(tabs)' : `/(tabs)/${tab}`);
  };

  const tabs = [
    { key: 'index' as const, label: 'Home', Icon: House },
    { key: 'quiz' as const, label: 'Quiz', Icon: Trophy },
    { key: 'social' as const, label: 'Social', Icon: Users },
    { key: 'library' as const, label: 'Library', Icon: Library },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Top bar: brush-K tile + Offline chip (HTML: pt-6 px-6). */}
      <View style={styles.topBar}>
        <View style={styles.logoTile}>
          <AppImage
            source={GLYPH}
            style={styles.logoGlyph}
            resizeMode="contain"
          />
        </View>
        <View style={styles.offlineChip}>
          <CloudOff size={17} color={theme.secondary} strokeWidth={2} />
          <Text style={styles.offlineChipText}>Offline</Text>
        </View>
      </View>

      {/* Hero + copy + actions, centred (HTML: flex-1, -mt-6). */}
      <View style={styles.center}>
        <View style={styles.heroWrap}>
          <View style={styles.heroCircle}>
            <WifiOff size={58} color={theme.accent} strokeWidth={2} />
          </View>
          <View style={styles.heroBadge}>
            <Download size={20} color="#FFFFFF" strokeWidth={2.5} />
          </View>
        </View>

        <Text style={styles.headline}>You’re offline</Text>
        <Text style={styles.support}>
          No connection right now — your downloaded themes are ready whenever
          you are.
        </Text>

        <View style={styles.countChip}>
          <CircleArrowDown size={17} color={theme.success} strokeWidth={2} />
          <Text style={styles.countText}>{savedThemesLabel(savedCount)}</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => router.push('/downloads')}
            accessibilityRole="button"
            accessibilityLabel="Go to Downloads"
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Download size={20} color={theme.onAccent} strokeWidth={2} />
            <Text style={styles.primaryText}>Go to Downloads</Text>
          </Pressable>
          <Pressable
            onPress={() => void retry()}
            accessibilityRole="button"
            accessibilityLabel="Retry connection"
            style={({ pressed }) => [
              styles.retryButton,
              pressed && styles.pressed,
            ]}
          >
            <RefreshCw size={16} color={theme.secondary} strokeWidth={2} />
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </View>

      {/* Bottom nav (HTML: full-bleed bar, Library active pill). */}
      <View
        style={[styles.nav, { paddingBottom: spacing.xxl + insets.bottom }]}
      >
        {tabs.map(({ key, label, Icon }) => {
          const focused = key === activeTab;
          return (
            <Pressable
              key={key}
              onPress={() => goTab(key)}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              style={styles.navTab}
            >
              <View
                style={[styles.navPill, focused && styles.navPillActive]}
              >
                <Icon
                  size={22}
                  color={focused ? '#FFFFFF' : HTML.inactiveTab}
                  strokeWidth={2}
                />
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
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.background,
      // Above the drawer content AND the MiniPlayer overlay the
      // drawer layout mounts — the takeover is full-screen.
      zIndex: 50,
      elevation: 50,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xxl,
      paddingTop: spacing.xxl,
      paddingBottom: spacing.sm,
    },
    logoTile: {
      // HTML: w-10 h-10 white tile, rounded-2xl, hairline border.
      width: 40,
      height: 40,
      borderRadius: radii.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.05,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    logoGlyph: {
      // HTML draws the K at w-6 (24) inside the 40px tile.
      width: 24,
      height: 24,
    },
    offlineChip: {
      // HTML: px-3 py-1.5, light-mauve fill #EFE4EE (the raised
      // family deepened a step — no theme token carries it),
      // border #E6D7E5, mauve label.
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radii.pill,
      backgroundColor: HTML.chipBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: HTML.chipBorder,
    },
    offlineChipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      letterSpacing: 0.4,
      color: theme.secondary,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.xxl,
      // HTML: -mt-6 — the centred block rides up a step.
      marginTop: -spacing.xxl,
    },
    heroWrap: {
      position: 'relative',
      marginBottom: 28,
    },
    heroCircle: {
      // HTML: w-32 h-32 (128), fill #F1E4EE, border #E9DCE7.
      width: 128,
      height: 128,
      borderRadius: 64,
      backgroundColor: HTML.heroBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: HTML.heroBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    heroBadge: {
      // HTML: w-10 h-10 sage circle at -bottom-1 -right-1, ring-4
      // in the page background colour.
      position: 'absolute',
      bottom: -4,
      right: -4,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.success,
      borderWidth: 4,
      borderColor: theme.background,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4,
    },
    headline: {
      // HTML: text-2xl bold, tracking tight.
      fontFamily: fontFamilies.display,
      fontSize: 24,
      letterSpacing: -0.3,
      color: theme.text,
      textAlign: 'center',
      marginBottom: 10,
    },
    support: {
      // HTML: text-sm mauve, medium, max-w 280, relaxed leading.
      ...typeStyles.body,
      fontFamily: fontFamilies.caption,
      lineHeight: 21,
      color: theme.secondary,
      textAlign: 'center',
      maxWidth: 280,
      marginBottom: spacing.xl,
    },
    countChip: {
      // HTML: px-4 py-2 white pill, border #E8DEE8, soft shadow.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: HTML.countBorder,
      shadowColor: '#000',
      shadowOpacity: 0.05,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
      marginBottom: 28,
    },
    countText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.text,
    },
    actions: {
      width: '100%',
      maxWidth: 320,
      alignItems: 'center',
      gap: 14,
    },
    primaryButton: {
      // HTML: w-full py-3.5 mauveDeep pill, download glyph + label.
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: 14,
      paddingHorizontal: spacing.xxl,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    primaryText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.onAccent,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
    retryText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.secondary,
    },
    nav: {
      // HTML: full-bleed #FAF8FC bar on a #E5DEE8 top hairline,
      // py-2.5 + the mock's pb-6 home-indicator room (the real
      // bottom inset is added inline).
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
      backgroundColor: HTML.navBg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: HTML.navBorder,
      paddingHorizontal: spacing.lg,
      paddingTop: 10,
      zIndex: 20,
    },
    navTab: {
      width: 48,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    navPill: {
      // Inactive tabs are bare icons (HTML: w-12 h-10 plain); the
      // active one carries the filled pill (HTML: w-14 h-9,
      // #825F87 — the active nav pill colour the approved screens
      // measure at, the same value family as theme.accent's
      // mauveDeep; the HTML literal is kept for this bar only).
      minWidth: 56,
      height: 36,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    navPillActive: {
      backgroundColor: '#825F87',
    },
    pressed: {
      opacity: 0.85,
    },
  });
