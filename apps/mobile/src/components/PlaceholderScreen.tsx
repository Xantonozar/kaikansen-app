import { useMemo, type ComponentType } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { CONTENT_MAX_WIDTH } from '../layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/**
 * Placeholder tab screen: compact icon-led chrome (approved mockup
 * v1) — a raised icon tile, the title, and one muted note, centred
 * in a width-capped column. The note stays verbatim: it is the
 * honest statement of what the slice does not have yet.
 */
export function PlaceholderScreen({
  title,
  note,
  Icon,
}: {
  title: string;
  note: string;
  Icon: IconComponent;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.container}>
      <View style={styles.tile}>
        <Icon size={26} color={theme.accent} strokeWidth={2} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.note}>{note}</Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  tile: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...typeStyles.heading,
    color: theme.text,
    textAlign: 'center',
  },
  note: {
    ...typeStyles.body,
    color: theme.muted,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 320,
    marginTop: spacing.sm,
  },
});
