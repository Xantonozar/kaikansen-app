import { useEffect, useMemo } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import {
  ABOUT_CREDITS,
  ABOUT_DESCRIPTION,
  ABOUT_LINKS,
  ABOUT_WHATS_NEW,
  aboutVersionLine,
} from '../../src/aboutContent';
import { installedBuild, useUpdate } from '../../src/appUpdateRuntime';
import { UpdateCard } from '../../src/components/UpdateCard';
import { CONTENT_MAX_WIDTH } from '../../src/layout';
import {
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';

// The app's real brush-K glyph — the same splash asset the
// offline screen renders (owner ruling: auth/offline glyph =
// the latest brush-K logo).
const GLYPH = require('../../assets/splash-icon.png');

/**
 * About (release readiness, 2026-11-11) — the app's real info
 * screen, reached from the Settings version footer and the
 * Settings About row. Everything on it is factual and, where it
 * can be, read at runtime: the version + build come from
 * expo-constants (never hardcoded), the facts live in
 * src/aboutContent.ts (unit-tested), the credits name the real
 * data sources, and the links open in the browser via
 * Linking.openURL — the app's existing pattern (anime detail's
 * AniList row).
 *
 * The App update section doubles as the manual check surface
 * (spec §2/§3): opening About re-runs the update check; the
 * section then shows the shared UpdateCard when an update state
 * is live, or "You're on the latest version." once a check has
 * completed clean. Before the first check settles it shows a
 * neutral "Checking for updates…" — never a claim either way.
 */
export default function AboutScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { state, check, pressUpdate, pressLater } = useUpdate();
  const build = installedBuild();

  // Manual re-check on open (spec §3): About is the surface a
  // user visits to ask "am I current?" — the check is silent on
  // failure, exactly like the launch check.
  useEffect(() => {
    check();
  }, [check]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <ArrowLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>About</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
          <Text style={styles.appName}>Kaikansen</Text>
          <Text style={styles.versionLine}>
            {aboutVersionLine(build.version, build.versionCode)}
          </Text>
          <Text style={styles.description}>{ABOUT_DESCRIPTION}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>App update</Text>
          {state.phase === 'available' ||
          state.phase === 'required' ||
          state.phase === 'downloading' ||
          state.phase === 'installing' ||
          state.phase === 'error' ? (
            <UpdateCard
              state={state}
              onUpdate={pressUpdate}
              onLater={pressLater}
            />
          ) : state.phase === 'checking' ? (
            <Text style={styles.caption}>Checking for updates…</Text>
          ) : (
            <Text style={styles.caption}>You’re on the latest version.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>What’s new in {build.version}</Text>
          {ABOUT_WHATS_NEW.map((line) => (
            <Text key={line} style={styles.listLine}>
              · {line}
            </Text>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Data & credits</Text>
          {ABOUT_CREDITS.map((credit) => (
            <View key={credit.label} style={styles.creditRow}>
              <Text style={styles.creditLabel}>{credit.label}</Text>
              <Text style={styles.creditValue}>{credit.value}</Text>
            </View>
          ))}
          {ABOUT_LINKS.map((link) => (
            <Pressable
              key={link.url}
              onPress={() => void Linking.openURL(link.url)}
              accessibilityRole="link"
              accessibilityLabel={`Open ${link.label}`}
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.linkLabel}>{link.label}</Text>
              <Text style={styles.linkUrl}>{link.url}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.display,
      color: theme.text,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.lg,
    },
    hero: {
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.md,
    },
    glyph: {
      width: 72,
      height: 72,
      borderRadius: radii.md,
    },
    appName: {
      ...typeStyles.wordmark,
      color: theme.wordmark,
    },
    versionLine: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    description: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    cardLabel: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    caption: {
      ...typeStyles.body,
      color: theme.muted,
    },
    listLine: {
      ...typeStyles.body,
      color: theme.muted,
    },
    creditRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    creditLabel: {
      ...typeStyles.body,
      color: theme.muted,
    },
    creditValue: {
      ...typeStyles.body,
      color: theme.text,
      flexShrink: 1,
      textAlign: 'right',
    },
    linkRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    linkLabel: {
      ...typeStyles.body,
      color: theme.secondary,
    },
    linkUrl: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      flexShrink: 1,
    },
    pressed: {
      opacity: 0.7,
    },
  });
