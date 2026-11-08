import { useEffect, useRef, useState } from 'react';
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
 */
export function CountdownRing({
  deadlineMs,
  totalSeconds,
  onExpire,
  size = 46,
}: {
  deadlineMs: number;
  totalSeconds: number;
  onExpire?: () => void;
  size?: number;
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
  }, [deadlineMs]);

  const totalMs = Math.max(1, totalSeconds * 1000);
  const fraction = Math.min(1, Math.max(0, remainingMs / totalMs));
  const seconds = Math.ceil(remainingMs / 1000);
  const urgent = remainingMs <= 5000 && remainingMs > 0;

  const stroke = 4;
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
        <Text style={[styles.label, urgent && { color: theme.secondary }]}>
          {seconds}
        </Text>
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
  });
