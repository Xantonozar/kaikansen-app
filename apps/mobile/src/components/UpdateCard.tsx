import { useMemo } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { AppVersionResponse } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import type { UpdateState } from '../appUpdate';

/**
 * The update card (release readiness, 2026-11-11) — ONE component
 * rendering every prompt state, in the app's card idiom (surface
 * card, radius 24, mauveDeep primary button — the tokens, no new
 * design language). Used by UpdatePromptGate (the shell overlay)
 * and by About's App update section (the manual check surface),
 * so the two can never drift apart.
 *
 * Honesty rules the card keeps:
 * - the progress fill is the resumable download's real byte
 *   fraction (the reducer clamps it; nothing draws ahead);
 * - the required variant has NO Later button — that absence IS
 *   the non-dismissibility, there is no second component;
 * - the error state always offers the browser fallback with the
 *   same apkUrl the in-app download just tried.
 */
export function UpdateCard({
  state,
  onUpdate,
  onLater,
}: {
  state: UpdateState;
  onUpdate: () => void;
  onLater: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (
    state.phase !== 'available' &&
    state.phase !== 'required' &&
    state.phase !== 'downloading' &&
    state.phase !== 'installing' &&
    state.phase !== 'error'
  ) {
    return null;
  }
  const { release } = state;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {state.phase === 'required'
          ? `Update required — Kaikansen ${release.latestVersion}`
          : `Update available — Kaikansen ${release.latestVersion}`}
      </Text>
      {release.notes.length > 0 && (
        <View style={styles.notes}>
          {release.notes.map((line, i) => (
            <Text key={i} style={styles.noteLine}>
              · {line}
            </Text>
          ))}
        </View>
      )}

      {state.phase === 'available' && (
        <View style={styles.actions}>
          <Pressable
            onPress={onUpdate}
            accessibilityRole="button"
            accessibilityLabel={`Update to Kaikansen ${release.latestVersion}`}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryLabel}>Update</Text>
          </Pressable>
          <Pressable
            onPress={onLater}
            accessibilityRole="button"
            accessibilityLabel="Remind me later"
            style={({ pressed }) => [
              styles.quiet,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.quietLabel}>Later</Text>
          </Pressable>
        </View>
      )}

      {state.phase === 'required' && (
        <View style={styles.actions}>
          <Pressable
            onPress={onUpdate}
            accessibilityRole="button"
            accessibilityLabel={`Update to Kaikansen ${release.latestVersion}`}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryLabel}>Update</Text>
          </Pressable>
        </View>
      )}

      {state.phase === 'downloading' && (
        <View>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.round(state.progress * 100)}%` },
              ]}
            />
          </View>
          <Text style={styles.caption}>
            Downloading… {Math.round(state.progress * 100)}%
          </Text>
        </View>
      )}

      {state.phase === 'installing' && (
        <Text style={styles.caption}>Opening the installer…</Text>
      )}

      {state.phase === 'error' && (
        <View>
          <Text style={styles.errorText}>{state.message}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={onUpdate}
              accessibilityRole="button"
              accessibilityLabel="Try the update again"
              style={({ pressed }) => [
                styles.primary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryLabel}>Try again</Text>
            </Pressable>
            <Pressable
              onPress={() => void Linking.openURL(release.apkUrl)}
              accessibilityRole="link"
              accessibilityLabel="Download in browser instead"
              style={({ pressed }) => [
                styles.quiet,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.quietLabel}>Download in browser instead</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.md,
      gap: spacing.sm,
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
    },
    notes: {
      gap: spacing.xs,
    },
    noteLine: {
      ...typeStyles.body,
      color: theme.muted,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    quiet: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    quietLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    pressed: {
      opacity: 0.7,
    },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.raised,
      overflow: 'hidden',
    },
    fill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: theme.secondary,
    },
    caption: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.xs,
    },
    errorText: {
      ...typeStyles.body,
      color: theme.danger,
    },
  });
