import { useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  cancelAnilistHandoff,
  setAnilistHandoffScreenMounted,
  useAnilistHandoff,
} from '../src/anilistHandoff';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../src/theme';
import { useTheme } from '../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../src/layout';

// The brand glyph (the splash asset: sakura petal + play mark).
const GLYPH = require('../assets/splash-icon.png');

/**
 * AniList handoff (DESIGN.md §6.3, layout-fidelity Slice 4) — the
 * waiting screen shown while the AniList browser consent is in
 * flight. The auth provider pushes this route before opening the
 * auth session (login AND link run through it) and pops it when
 * the deep link returns: success continues into the callers'
 * existing signed-in/linked outcomes, failure into their existing
 * inline errors with the same button as the retry — §6.3's three
 * states ride the flows that already worked.
 *
 * This screen only renders the wait and owns Cancel: cancelling
 * dismisses the browser session for real and marks the flow so a
 * late resolution is discarded by the provider (see
 * src/anilistHandoff.ts). Unmounting mid-flow (backing out before
 * the browser opened) marks the cancel the same way.
 */
export default function AnilistHandoffScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const handoff = useAnilistHandoff();

  useEffect(() => {
    setAnilistHandoffScreenMounted(true);
    return () => setAnilistHandoffScreenMounted(false);
  }, []);

  const onCancel = () => {
    if (handoff.active) {
      // Dismisses the browser session; the provider pops this
      // screen when the dismissed flow settles as a cancellation.
      cancelAnilistHandoff();
    } else if (router.canGoBack()) {
      router.back();
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
          <Text style={styles.wordmark}>KAIKANSEN</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.ring}>
            <ActivityIndicator size="large" color={theme.accent} />
          </View>
          <Text style={styles.cardTitle}>Continue in your browser</Text>
          <Text style={styles.cardBody}>
            AniList is asking you to approve the connection. Finish there,
            then come back to this screen.
          </Text>
        </View>

        <View style={styles.statusRow}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Waiting for AniList…</Text>
        </View>

        <View style={styles.spacer} />

        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel AniList sign-in"
          style={({ pressed }) => [
            styles.cancelButton,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    content: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.xxxl,
      paddingBottom: spacing.xl,
      alignItems: 'center',
    },
    brand: {
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.xxl,
    },
    glyph: {
      width: 84,
      height: 84,
    },
    wordmark: {
      ...typeStyles.display,
      fontFamily: fontFamilies.display,
      color: theme.text,
      letterSpacing: 4,
    },
    card: {
      alignSelf: 'stretch',
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.xl,
      alignItems: 'center',
    },
    ring: {
      width: 64,
      height: 64,
      borderRadius: radii.pill,
      borderWidth: 3,
      borderColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.lg,
    },
    cardTitle: {
      ...typeStyles.heading,
      color: theme.text,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    cardBody: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 20,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.xl,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: radii.pill,
      backgroundColor: theme.success,
    },
    statusText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    spacer: {
      flex: 1,
    },
    cancelButton: {
      alignSelf: 'stretch',
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    pressed: {
      opacity: 0.85,
    },
  });
