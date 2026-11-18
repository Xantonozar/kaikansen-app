import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, Search } from 'lucide-react-native';
import type { ChatPerson } from '@kaikansen/contracts';
import {
  fetchChatPeople,
  openConversation,
  searchChatPeople,
} from '../../../src/chatApi';
import { rankRpLine } from '../../../src/chatLogic';
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
 * New Chat — live username search on top, then the two server
 * sections: FROM YOUR QUIZ ROOMS (co-players reconstructed from
 * RankHistory roomIds) and SUGGESTED (followees, then other
 * users). Each row's deep-mauve Message pill opens/creates the
 * conversation and replaces this screen with the thread.
 */
export default function NewChatScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatPerson[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [quizRoomPeople, setQuizRoomPeople] = useState<ChatPerson[]>([]);
  const [suggested, setSuggested] = useState<ChatPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    let live = true;
    fetchChatPeople()
      .then((res) => {
        if (!live) return;
        setQuizRoomPeople(res.quizRoomPeople);
        setSuggested(res.suggested);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      searchChatPeople(q)
        .then((res) => {
          if (seq === searchSeq.current) setResults(res.users);
        })
        .catch(() => {
          if (seq === searchSeq.current) setResults([]);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const openChat = useCallback(
    async (person: ChatPerson) => {
      if (openingId) return;
      setOpeningId(person.id);
      try {
        const res = await openConversation(person.id);
        router.replace(`/chat/${res.conversation.id}`);
      } catch {
        setOpeningId(null);
      }
    },
    [openingId, router],
  );

  const renderPerson = (person: ChatPerson) => (
    <View key={person.id} style={styles.row}>
      <Avatar
        url={person.avatarUrl}
        name={person.displayName || person.username}
        seed={person.id}
        size={44}
        disableDefaultAvatar
      />
      <View style={styles.rowMain}>
        <Text style={styles.username} numberOfLines={1}>
          {person.username}
        </Text>
        <Text style={styles.rankLine} numberOfLines={1}>
          {rankRpLine(person)}
        </Text>
      </View>
      <Pressable
        onPress={() => void openChat(person)}
        disabled={openingId === person.id}
        accessibilityRole="button"
        accessibilityLabel={`Message ${person.username}`}
        style={({ pressed }) => [styles.messagePill, pressed && styles.pressed]}
      >
        {openingId === person.id ? (
          <ActivityIndicator size="small" color={theme.onAccent} />
        ) : (
          <Text style={styles.messagePillText}>Message</Text>
        )}
      </Pressable>
    </View>
  );

  const renderSection = (title: string, people: ChatPerson[]) =>
    people.length === 0 ? null : (
      <View key={title} style={styles.section}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.card}>
          {people.map((person, index) => (
            <View key={person.id}>
              {index > 0 && <View style={styles.divider} />}
              {renderPerson(person)}
            </View>
          ))}
        </View>
      </View>
    );

  const searchingActive = query.trim().length >= 2;

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
        <Text style={styles.title}>New chat</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.searchField}>
          <Search size={18} color={theme.muted} strokeWidth={2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by username"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchInput}
            accessibilityLabel="Search by username"
          />
        </View>

        <ScrollView
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {searchingActive ? (
            searching ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : results && results.length > 0 ? (
              <View style={styles.card}>
                {results.map((person, index) => (
                  <View key={person.id}>
                    {index > 0 && <View style={styles.divider} />}
                    {renderPerson(person)}
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.center}>
                <Text style={styles.emptyText}>
                  No one matches “{query.trim()}”.
                </Text>
              </View>
            )
          ) : loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : (
            <>
              {renderSection('FROM YOUR QUIZ ROOMS', quizRoomPeople)}
              {renderSection('SUGGESTED', suggested)}
              {quizRoomPeople.length === 0 && suggested.length === 0 && (
                <View style={styles.center}>
                  <Text style={styles.emptyText}>
                    Play a quiz room or follow people to find them here.
                  </Text>
                </View>
              )}
            </>
          )}
        </ScrollView>
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
      gap: spacing.md,
    },
    searchField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
    },
    searchInput: {
      ...typeStyles.body,
      flex: 1,
      color: theme.text,
      paddingVertical: spacing.sm + 2,
    },
    list: { gap: spacing.lg, paddingBottom: spacing.lg },
    section: { gap: spacing.sm },
    sectionTitle: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.8,
      color: theme.muted,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      overflow: 'hidden',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: spacing.md + 44 + spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 64,
    },
    rowMain: { flex: 1, gap: 2 },
    username: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    rankLine: { ...typeStyles.bodySmall, color: theme.muted },
    messagePill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md + 2,
      paddingVertical: spacing.xs + 2,
      minWidth: 78,
      alignItems: 'center',
    },
    messagePillText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    pressed: { opacity: 0.7 },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.xxl,
      paddingHorizontal: spacing.lg,
    },
    emptyText: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 21,
    },
  });
