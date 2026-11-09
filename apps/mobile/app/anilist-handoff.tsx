import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';
import {
  cancelAnilistHandoff,
  setAnilistHandoffScreenMounted,
  useAnilistHandoff,
} from '../src/anilistHandoff';
import {
  fontFamilies,
  radii,
  spacing,
  withOpacity,
  type Theme,
} from '../src/theme';
import { useTheme } from '../src/theme-context';

// The brand glyph — the current brush-K logo asset (the same
// splash-icon the login/register brand headers draw).
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
 *
 * Layout measured from the Stitch AniList Handoff screen (the
 * Lavender Dusk handoff pack's HTML is the measurement truth):
 * a max-w-sm (384) column, the brand block and card vertically
 * centred, Cancel pinned at the bottom. The spinner is the
 * mock's own ring + quarter arc (40pt, 3.5 stroke) rotating on
 * its 1.6s cubic-bezier loop, and the waiting line carries the
 * mock's gentle 2.2s opacity pulse — both run only while this
 * screen is mounted, i.e. only while the flow is genuinely
 * pending; success unmounts the screen into the callers'
 * landings (see AuthForm's AniList success path).
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

  // The mock's two loops: the spinner's 1.6s rotation and the
  // waiting line's 2.2s gentle pulse (opacity 0.6 ↔ 1).
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const spinLoop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1600,
        easing: Easing.bezier(0.5, 0.1, 0.5, 0.9),
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.6,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    spinLoop.start();
    pulseLoop.start();
    return () => {
      spinLoop.stop();
      pulseLoop.stop();
    };
  }, [spin, pulse]);

  const spinRotation = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

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
      <View style={styles.column}>
        <View style={styles.main}>
          <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
          <Text style={styles.wordmark}>KAIKANSEN</Text>

          <View style={styles.card}>
            <Animated.View
              style={[
                styles.spinner,
                { transform: [{ rotate: spinRotation }] },
              ]}
            >
              <Svg width={40} height={40} viewBox="0 0 44 44" fill="none">
                <Circle
                  cx={22}
                  cy={22}
                  r={18}
                  stroke={theme.raised}
                  strokeWidth={3.5}
                />
                <Path
                  d="M 22 4 C 31.94 4 40 12.06 40 22"
                  stroke={theme.accent}
                  strokeWidth={3.5}
                  strokeLinecap="round"
                />
              </Svg>
            </Animated.View>
            <Text style={styles.cardTitle}>Continue in your browser</Text>
            <Text style={styles.cardBody}>
              AniList is asking you to approve the connection. Finish there,
              then come back to this screen.
            </Text>
          </View>

          <Animated.View style={[styles.statusRow, { opacity: pulse }]}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>Waiting for AniList...</Text>
          </Animated.View>
        </View>

        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel AniList sign-in"
          style={({ pressed }) => [
            styles.cancelButton,
            pressed && styles.cancelPressed,
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
    column: {
      flex: 1,
      width: '100%',
      // The mock's column: max-w-sm (384) with px-6 (24) sides.
      maxWidth: 384,
      alignSelf: 'center',
      paddingHorizontal: spacing.xxl,
      paddingTop: spacing.xxxl,
      paddingBottom: spacing.xxl,
    },
    // The mock centres the brand + card + status block vertically
    // (my-auto) between the top spacer and the Cancel footer.
    main: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
    },
    glyph: {
      width: 80,
      height: 80,
      marginBottom: spacing.xl,
    },
    wordmark: {
      // Mock: 12pt extrabold, tracking 0.32em (3.84 at 12pt),
      // in the mauveDeep wordmark colour.
      fontFamily: fontFamilies.wordmark,
      fontSize: 12,
      letterSpacing: 3.84,
      color: theme.wordmark,
      marginBottom: 28,
    },
    card: {
      alignSelf: 'stretch',
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: theme.border,
      // Mock card padding: px-6 (24) / py-7 (28).
      paddingHorizontal: spacing.xxl,
      paddingVertical: 28,
      alignItems: 'center',
      marginBottom: spacing.xl,
    },
    spinner: {
      width: 40,
      height: 40,
      marginBottom: spacing.xl,
    },
    cardTitle: {
      // Mock: 17pt bold, tracking-tight (-0.025em). DESIGN.md
      // headings are Outfit; fontFamilies.display is its 700 cut.
      fontFamily: fontFamilies.display,
      fontSize: 17,
      letterSpacing: -0.4,
      color: theme.text,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    cardBody: {
      // Mock: 13.5pt regular, relaxed leading (×1.625 ≈ 22),
      // max-w 270, in the mauve (#8E5B7B = theme.secondary).
      fontFamily: fontFamilies.body,
      fontSize: 13.5,
      lineHeight: 22,
      color: theme.secondary,
      textAlign: 'center',
      maxWidth: 270,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    statusDot: {
      // Mock: 6pt dot in mauve at 70%.
      width: 6,
      height: 6,
      borderRadius: radii.pill,
      backgroundColor: withOpacity(theme.accent, 0.7),
    },
    statusText: {
      // Mock: 12pt medium in the mauve at 90%.
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: withOpacity(theme.secondary, 0.9),
    },
    cancelButton: {
      alignSelf: 'stretch',
      // Mock: lavender pill fill (#EDE4ED = theme.raised) with a
      // hairline border at 60%; py-3.5 (14).
      backgroundColor: theme.raised,
      borderWidth: 1,
      borderColor: withOpacity(theme.border, 0.6),
      borderRadius: radii.pill,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelPressed: {
      // The mock's hover/active fill is its pill-border colour.
      backgroundColor: theme.border,
    },
    cancelText: {
      // Mock: 14pt semibold in mauveDeep.
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.accent,
    },
  });
