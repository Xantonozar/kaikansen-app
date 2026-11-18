import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ChatBlockedUser } from '@kaikansen/contracts';
import { fetchBlockedUsers, unblockChatUser } from '../../../src/chatApi';
import { Avatar } from '../../../src/components/Avatar';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Blocked users (deep-analysis fix pass) — the management list
 * for DM blocks: everyone I have blocked, each with an Unblock
 * button. Unblocking reopens a pair conversation that has
 * messages (server semantics — see the API's unblockUser).
 * Reached from the Chats header list; the app's one-container
 * hairline list treatment, like the inbox.
 */
export default function BlockedUsersScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [users, setUsers] = useState<ChatBlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchBlockedUsers();
      setUsers(res.users);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onUnblock = async (item: ChatBlockedUser) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await unblockChatUser(item.id);
      setUsers((current) => current.filter((u) => u.id !== item.id));
    } catch {
      // Leave the row; the user can retry.
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = ({ item }: { item: ChatBlockedUser }) => (
    <View style={styles.row}>
      <Avatar
        url={item.avatarUrl}
        name={item.displayName || item.username}
        seed={item.id}
        size={48}
        disableDefaultAvatar
      />
      <View style={styles.rowMain}>
        <Text style={styles.username} numberOfLines={1}>
          {item.username}
        </Text>
        <Text style={styles.preview} numberOfLines={1}>
          {item.displayName}
        </Text>
      </View>
      <Pressable
        onPress={() => void onUnblock(item)}
        disabled={busyId === item.id}
        accessibilityRole="button"
        accessibilityLabel={`Unblock ${item.username}`}
        style={({ pressed }) => [styles.unblockPill, pressed && styles.pressed]}
      >
        {busyId === item.id ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <Text style={styles.unblockText}>Unblock</Text>
        )}
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.headerButton}
        >
          <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Blocked users</Text>
      </View>

      <View style={styles.body}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>Couldn’t load blocked users.</Text>
            <Pressable
              onPress={() => void load()}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : users.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              You haven’t blocked anyone. Peaceful inbox.
            </Text>
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(u) => u.id}
            renderItem={renderRow}
            ItemSeparatorComponent={() => <View style={styles.divider} />}
            style={styles.card}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
    },
    headerButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...typeStyles.heading, flex: 1, color: theme.text },
    body: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.lg,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      overflow: 'hidden',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: spacing.md + 48 + spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 68,
    },
    pressed: { opacity: 0.7 },
    rowMain: { flex: 1, gap: 2 },
    username: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    preview: { ...typeStyles.bodySmall, color: theme.muted },
    unblockPill: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      backgroundColor: theme.raised,
      minWidth: 86,
      alignItems: 'center',
    },
    unblockText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xxl,
    },
    emptyText: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 21,
    },
    retryButton: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: theme.raised,
    },
    retryText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
  });
