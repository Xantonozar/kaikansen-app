import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/** Slice 0 placeholder tab screen: title + one muted line (DESIGN.md scope). */
export function PlaceholderScreen({ title, note }: { title: string; note: string }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.container}>
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
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.xxl,
    gap: spacing.sm,
  },
  title: {
    ...typeStyles.display,
    color: theme.text,
  },
  note: {
    ...typeStyles.body,
    color: theme.muted,
    lineHeight: 20,
  },
});
