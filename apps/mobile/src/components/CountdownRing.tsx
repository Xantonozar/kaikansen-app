import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { fontFamilies, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Countdown ring (Slice M4) — a locally-driven display timer. The
 * deadline is an epoch-ms timestamp (for multiplayer it is derived
 * from the server's round `startedAt` + `timeLimitSeconds`, so the
 * ring self-corrects against the server's clock; the server owns
 * the actual round end either way). `onExpire` fires exactly once
 * per deadline — solo uses it to submit the timeout answer.
 *
 * `paused` (solo timing fix, 2026-11-10): while true the ring
 * renders the FULL window and never ticks or expires — solo holds
 * it until the question's audio actually starts, so load time
 * never eats the displayed window; the caller moves the deadline
 * to the real start moment as it unpauses.
 *
 * `holdSeconds` (clock-lag fix F3, 2026-11-12): while non-null
 * the ring renders EXACTLY that many seconds remaining and never
 * ticks or expires — solo passes the value captured at the
 * answer moment (mediaEngine.ringHoldSecondsAtAnswer) through
 * the feedback window, so the displayed clock stops when the
 * answer lands instead of counting down over the reveal. It is
 * a distinct mode from `paused` on purpose: `paused` means
 * "not started yet, show the full window", `holdSeconds` means
 * "finished, show where it stopped". Hold wins when both are
 * set.
 */
export function CountdownRing({
  deadlineMs,
  totalSeconds,
  onExpire,
  size = 46,
  glyph,
  caption,
  variant = 'standard',
  paused = false,
  holdSeconds,
}: {
  deadlineMs: number;
  totalSeconds: number;
  onExpire?: () => void;
  size?: number;
  /** Held at the full window: no ticking, no expiry. */
  paused?: boolean;
  /** Frozen at this many seconds remaining: no ticking, no
   *  expiry. Null/undefined = not held (see the docblock). */
  holdSeconds?: number | null;
  /** Large rings only: a glyph rendered above the seconds number
   *  (the solo question screen's music note / buffering spinner). */
  glyph?: ReactNode;
  /** Large rings only: a caption under the seconds number
   *  (the solo question screen's "seconds"). */
  caption?: string;
  /** 'room' = the Quiz Room in-game design's centrepiece cut:
   *  a 30pt accent number over a 10pt uppercase seconds caption.
   *  The default keeps the solo question screen's styling. */
  variant?: 'standard' | 'room';
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, deadlineMs - Date.now()),
  );
  const expiredForRef = useRef<number | null>(null);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    if (holdSeconds != null) {
      // Frozen at the answer moment (see the docblock): render
      // the held value verbatim — no ticking, no expiry, and
      // never the deadline's live remainder.
      setRemainingMs(Math.max(0, holdSeconds * 1000));
      return;
    }
    if (paused) {
      // Held at the full window (see the docblock): no ticking,
      // no expiry — the deadline takes over when `paused` lifts.
      setRemainingMs(Math.max(1, totalSeconds * 1000));
      return;
    }
    expiredForRef.current = null;
    setRemainingMs(Math.max(0, deadlineMs - Date.now()));
    const tick = () => {
      const left = Math.max(0, deadlineMs - Date.now());
      setRemainingMs(left);
      if (left <= 0 && expiredForRef.current !== deadlineMs) {
        expiredForRef.current = deadlineMs;
        expireRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [deadlineMs, paused, totalSeconds, holdSeconds]);

  const totalMs = Math.max(1, totalSeconds * 1000);
  const fraction = Math.min(1, Math.max(0, remainingMs / totalMs));
  const seconds = Math.ceil(remainingMs / 1000);
  const urgent = remainingMs <= 5000 && remainingMs > 0;

  const large = size >= 100;
  const stroke = large ? 8 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ringColor = urgent ? theme.secondary : theme.accent;

  return (
    <View
      style={[styles.wrap, { width: size, height: size }]}
      accessibilityRole="timer"
      accessibilityLabel={`${seconds} seconds left`}
    >
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.raised}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={ringColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.labelWrap}>
        {glyph}
        <Text
          style={[
            styles.label,
            large && styles.labelLarge,
            variant === 'room' && styles.labelRoom,
            urgent && { color: theme.secondary },
          ]}
        >
          {seconds}
        </Text>
        {caption ? (
          <Text
            style={[
              styles.caption,
              variant === 'room' && styles.captionRoom,
            ]}
          >
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    labelWrap: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      fontFamily: fontFamilies.mono,
      fontSize: 15,
      color: theme.text,
    },
    labelLarge: {
      fontFamily: fontFamilies.display,
      fontSize: 40,
      lineHeight: 44,
    },
    labelRoom: {
      fontSize: 30,
      lineHeight: 34,
      color: theme.accent,
    },
    caption: {
      fontFamily: fontFamilies.body,
      fontSize: 13,
      color: theme.muted,
    },
    captionRoom: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: theme.secondary,
      marginTop: 2,
    },
  });
