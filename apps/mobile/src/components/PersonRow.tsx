import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { Avatar } from './Avatar';

/**
 * Person row (Slice M5) — the shared list unit for people search
 * results and the profile network lists: avatar, display name,
 * @username, chevron. Tapping routes to that user's profile
 * (the caller supplies onPress).
 */
export function PersonRow({
  displayName,
  username,
  avatarUrl,
  onPress,
}: {
  displayName: string;
  username: string;
  avatarUrl: string | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${displayName}'s profile`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar url={avatarUrl} name={displayName || username} size={40} />
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={1}>
          {displayName || username}
        </Text>
        <Text style={styles.handle} numberOfLines={1}>
          @{username}
        </Text>
      </View>
      <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      // Lavender Dusk: people lists are white card rows (Network mock).
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 56,
      padding: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      marginBottom: spacing.sm,
    },
    pressed: {
      opacity: 0.7,
    },
    main: {
      flex: 1,
      gap: 1,
    },
    name: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    handle: {
      ...typeStyles.caption,
      color: theme.muted,
    },
  });
