import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Check, Music2, X } from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import {
  GENERATING_STEPS,
  generatingProgressAt,
  generatingStageAt,
} from '../quizGenerating';

/**
 * Solo quiz generating screen (approved Stitch design cfc7c9ac,
 * ozar "Keep" 2026-11-11) — replaces the bare spinner the solo
 * 'creating' phase used to show while the server deals a game.
 *
 * A waiting screen, and it MOVES: the hero ring's mauve arc
 * breathes between ~44% and ~70% fill (the design rests at
 * ~⅔), the active step carries a spinning arc, the step states
 * advance on the pure presentational cadence in
 * src/quizGenerating.ts, and the slim progress bar creeps
 * toward — never to — 90%. Nothing here observes the server's
 * real dealing steps: the last step stays "Loading" until the
 * game actually arrives and the phase transition unmounts this
 * screen, so no shown state can contradict reality.
 *
 * The ✕ is the question screen's leave-game action (the caller
 * passes solo's goBack); the create effect's live-guard makes a
 * late resolution after leaving harmless.
 */

const RING_SIZE = 108;
const RING_STROKE = 9;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SPIN_SIZE = 26;
const SPIN_STROKE = 3;
const SPIN_RADIUS = (SPIN_SIZE - SPIN_STROKE) / 2;
const SPIN_CIRCUMFERENCE = 2 * Math.PI * SPIN_RADIUS;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function QuizGenerating({ onExit }: { onExit: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);

  /* Presentational clock: drives the step cadence and the
     progress creep from the pure module (the CountdownRing
     screen ticks the same way). */
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const shownAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - shownAt), 100);
    return () => clearInterval(id);
  }, []);
  const stage = generatingStageAt(elapsedMs);
  const progress = generatingProgressAt(elapsedMs);

  /* Hero ring breathing: the arc's visible fill oscillates
     ~44% ↔ ~70% by walking the dash offset (the CountdownRing
     dash technique — a full-circumference dash whose offset
     leaves exactly `fraction` of the path showing, starting at
     the top). */
  const arc = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(arc, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(arc, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [arc]);
  const arcOffset = arc.interpolate({
    inputRange: [0, 1],
    outputRange: [
      RING_CIRCUMFERENCE * (1 - 0.7),
      RING_CIRCUMFERENCE * (1 - 0.44),
    ],
  });

  /* Active-step spinner rotation. */
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 950,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const spinRotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const stepRow = (label: string, index: number) => {
    const state =
      index < stage ? 'done' : index === stage ? 'active' : 'waiting';
    return (
      <View
        key={label}
        style={[styles.stepRow, state === 'active' && styles.stepRowActive]}
      >
        {state === 'done' ? (
          <View style={styles.doneDisc}>
            <Check size={15} color="#FFFFFF" strokeWidth={3} />
          </View>
        ) : state === 'active' ? (
          <Animated.View style={{ transform: [{ rotate: spinRotate }] }}>
            <Svg width={SPIN_SIZE} height={SPIN_SIZE}>
              <Circle
                cx={SPIN_SIZE / 2}
                cy={SPIN_SIZE / 2}
                r={SPIN_RADIUS}
                stroke={theme.raised}
                strokeWidth={SPIN_STROKE}
                fill="none"
              />
              <Circle
                cx={SPIN_SIZE / 2}
                cy={SPIN_SIZE / 2}
                r={SPIN_RADIUS}
                stroke={theme.accent}
                strokeWidth={SPIN_STROKE}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${SPIN_CIRCUMFERENCE * 0.38} ${
                  SPIN_CIRCUMFERENCE * 0.62
                }`}
              />
            </Svg>
          </Animated.View>
        ) : (
          <View style={styles.waitingCircle} />
        )}
        <Text
          style={[
            styles.stepLabel,
            state === 'active' && styles.stepLabelActive,
            state === 'waiting' && styles.stepLabelWaiting,
          ]}
        >
          {label}
        </Text>
        {state === 'done' ? (
          <View style={styles.readyPill}>
            <Text style={styles.readyPillText}>Ready</Text>
          </View>
        ) : state === 'active' ? (
          <View style={styles.loadingWrap}>
            <View style={styles.loadingDot} />
            <Text style={styles.loadingText}>Loading</Text>
          </View>
        ) : (
          <Text style={styles.waitingText}>Waiting</Text>
        )}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.topRow}>
        <Pressable
          onPress={onExit}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Leave game"
          style={({ pressed }) => [
            styles.backDisc,
            pressed && styles.pressed,
          ]}
        >
          <X size={20} color={theme.text} strokeWidth={2} />
        </Pressable>
        <View style={styles.topCentre}>
          <View style={styles.modeChip}>
            <Music2 size={13} color={theme.accent} strokeWidth={2} />
            <Text style={styles.modeChipText}>Solo Run</Text>
          </View>
        </View>
        <View style={styles.topSpacer} />
      </View>

      <View style={styles.hero}>
        <Svg width={RING_SIZE} height={RING_SIZE}>
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke={theme.raised}
            strokeWidth={RING_STROKE}
            fill="none"
          />
          <AnimatedCircle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke={theme.accent}
            strokeWidth={RING_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={arcOffset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </Svg>
        <View style={styles.heroGlyph}>
          <Music2 size={30} color={theme.accent} strokeWidth={2} />
        </View>
      </View>

      <Text style={styles.title}>Setting up your quiz</Text>
      <Text style={styles.subtitle}>This can take a few seconds</Text>

      <View style={styles.card}>
        {GENERATING_STEPS.map((label, i) => stepRow(label, i))}
      </View>

      <View style={styles.bottom}>
        <View style={styles.progressTrack}>
          <View
            style={[styles.progressFill, { width: `${progress * 100}%` }]}
          />
        </View>
        <Text style={styles.caption}>Kaikansen</Text>
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      paddingHorizontal: spacing.screenEdge,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: spacing.md,
    },
    backDisc: {
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
    topCentre: {
      flex: 1,
      alignItems: 'center',
    },
    modeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    modeChipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.onAccentContainer,
    },
    topSpacer: {
      width: 40,
    },
    hero: {
      alignSelf: 'center',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xxxl + spacing.xl,
      width: RING_SIZE,
      height: RING_SIZE,
    },
    heroGlyph: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontFamily: fontFamilies.display,
      fontSize: 25,
      color: theme.text,
      textAlign: 'center',
      marginTop: spacing.xxxl,
    },
    subtitle: {
      fontFamily: fontFamilies.body,
      fontSize: 15,
      color: theme.secondary,
      textAlign: 'center',
      marginTop: 6,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.sm,
      marginTop: spacing.xxxl + spacing.lg,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
    },
    stepRowActive: {
      backgroundColor: theme.accentContainer,
    },
    doneDisc: {
      width: SPIN_SIZE,
      height: SPIN_SIZE,
      borderRadius: radii.pill,
      backgroundColor: theme.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
    waitingCircle: {
      width: SPIN_SIZE,
      height: SPIN_SIZE,
      borderRadius: radii.pill,
      borderWidth: 2,
      borderColor: theme.border,
    },
    stepLabel: {
      fontFamily: fontFamilies.body,
      fontSize: 15,
      color: theme.text,
      flex: 1,
    },
    stepLabelActive: {
      fontFamily: fontFamilies.bodyStrong,
    },
    stepLabelWaiting: {
      color: theme.muted,
    },
    readyPill: {
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    readyPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.success,
    },
    loadingWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    loadingDot: {
      width: 7,
      height: 7,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
    },
    loadingText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.accent,
    },
    waitingText: {
      fontFamily: fontFamilies.body,
      fontSize: 13,
      color: theme.muted,
    },
    bottom: {
      flex: 1,
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingBottom: spacing.xxxl,
    },
    progressTrack: {
      width: '64%',
      height: 5,
      borderRadius: 3,
      backgroundColor: theme.raised,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    caption: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      letterSpacing: 0.5,
      color: theme.muted,
      marginTop: spacing.sm + 2,
    },
  });
