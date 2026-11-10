import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Send } from 'lucide-react-native';
import type { ThemeComment } from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../api';
import { useAuth } from '../auth';
import { fetchComments, postComment } from '../socialApi';
import { relativeTime } from '../time';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { Avatar } from './Avatar';

const MAX_LENGTH = 1000;

/**
 * Theme comments (Slice M5) — the detail screen's bottom section:
 * GET /themes/:slug/comments (newest first) plus the composer.
 * The web's surface is exactly list + post — no replies, likes,
 * edits or deletes exist, so none are drawn.
 *
 * Load more (fix batch 2026-11-11): the API pages the list
 * (page/limit + total/hasMore meta, replacing the old silent
 * 100 cap) and the thread appends pages — the section is
 * embedded in the detail screen's ScrollView, so the footer
 * itself is the trigger surface: it fires the next page when
 * it lays out at the section's tail (the onEndReached
 * equivalent here) and stays tappable as a manual affordance,
 * with a spinner while a page is in flight.
 *
 * A comment whose author account is gone renders with a muted
 * "Deleted user" name (the API serves author: null, like the web's
 * populate). Posting prepends the server's returned comment, so the
 * list order stays the server's; server rejections show verbatim
 * under the composer. Fixture mode resolves an empty list and shows
 * a demo note instead of a composer — demo mode posts nothing.
 */
export function ThemeComments({ slug }: { slug: string }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user } = useAuth();
  const signedIn = status === 'signedIn';

  const [comments, setComments] = useState<ThemeComment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  /* Silent swap (perf problem 5): a background revalidation of
     the CATALOGUE-cached comments replaces the list in place.
     The cache entry is page 1 — the swap re-bases the paging
     state to it (fix batch 2026-11-11): locally appended older
     pages belong to the previous snapshot, so they are dropped
     rather than spliced under a new page 1. */
  useEffect(() => {
    if (fixtureMode) return;
    return subscribeCache(
      cacheKeyFor(`/themes/${encodeURIComponent(slug)}/comments`),
      (fresh: {
        comments: ThemeComment[];
        total?: number;
        hasMore?: boolean;
      }) => {
        setComments(fresh.comments);
        setTotal(fresh.total ?? fresh.comments.length);
        setHasMore(fresh.hasMore ?? false);
        pageRef.current = 1;
      },
    );
  }, [slug]);

  useEffect(() => {
    let live = true;
    setComments(null);
    setTotal(0);
    setHasMore(false);
    pageRef.current = 1;
    setLoadError(null);
    setDraft('');
    setPostError(null);
    fetchComments(slug)
      .then((res) => {
        if (live) {
          setComments(res.comments);
          setTotal(res.total);
          setHasMore(res.hasMore);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load comments.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [slug]);

  /* Append the next page (fix batch 2026-11-11). Called by the
     section's end-reached sentinel below. Deduped by id on
     append: a comment posted while paging shifts the server's
     pages by one, and the boundary row must not render twice. */
  const loadMore = () => {
    if (!hasMore || loadingMoreRef.current || comments === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const next = pageRef.current + 1;
    fetchComments(slug, next)
      .then((res) => {
        pageRef.current = res.page;
        setHasMore(res.hasMore);
        setTotal(res.total);
        setComments((prev) => {
          if (prev === null) return res.comments;
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...res.comments.filter((c) => !seen.has(c.id))];
        });
      })
      .catch(() => {
        // A failed page leaves the list as-is; the sentinel can
        // fire again on the next scroll pass and retry the page.
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };

  const trimmed = draft.trim();
  const canPost =
    signedIn && !posting && trimmed.length > 0 && draft.length <= MAX_LENGTH;

  const onPost = () => {
    if (!canPost) return;
    setPosting(true);
    setPostError(null);
    postComment(slug, draft)
      .then((created) => {
        setComments((prev) => [created, ...(prev ?? [])]);
        setTotal((prev) => prev + 1);
        setDraft('');
      })
      .catch((e: unknown) =>
        setPostError(
          e instanceof Error ? e.message : 'Could not post your comment.',
        ),
      )
      .finally(() => setPosting(false));
  };

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        {/* The mock's heading is the bare word (design polish
            pass) — no leading icon. */}
        <Text style={styles.heading}>Comments</Text>
        {comments !== null && total > 0 && (
          <Text style={styles.count}>{total}</Text>
        )}
      </View>

      {fixtureMode ? (
        <Text style={styles.note}>
          Comments are not available in demo mode.
        </Text>
      ) : loadError ? (
        <Text style={styles.errorText}>{loadError}</Text>
      ) : comments === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <>
          {signedIn ? (
            <View style={styles.composer}>
              <View style={styles.composerField}>
                <Avatar
                  url={user?.avatarUrl ?? null}
                  name={user?.displayName || user?.username || '?'}
                  seed={user?.id}
                  size={36}
                />
                <View style={styles.composerInputWrap}>
                  <TextInput
                    style={styles.composerInput}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Add a comment…"
                    placeholderTextColor={theme.muted}
                    multiline
                    maxLength={MAX_LENGTH + 100}
                    accessibilityLabel="Write a comment"
                  />
                </View>
                <Pressable
                  onPress={onPost}
                  disabled={!canPost}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel="Post comment"
                  accessibilityState={{ disabled: !canPost }}
                  style={({ pressed }) => [
                    styles.sendTile,
                    !canPost && styles.sendTileDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {posting ? (
                    <ActivityIndicator size="small" color={theme.onAccent} />
                  ) : (
                    <Send size={16} color={theme.onAccent} strokeWidth={2} />
                  )}
                </Pressable>
              </View>
              <View style={styles.composerMeta}>
                {postError ? (
                  <Text style={styles.errorText}>{postError}</Text>
                ) : (
                  <View />
                )}
                <Text
                  style={[
                    styles.counter,
                    draft.length > MAX_LENGTH && styles.counterOver,
                  ]}
                >
                  {draft.length}/{MAX_LENGTH}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.loginPrompt}>
              <Text style={styles.note}>Log in to comment.</Text>
              <Pressable
                onPress={() => router.push('/login')}
                accessibilityRole="button"
                accessibilityLabel="Log in"
                style={({ pressed }) => [
                  styles.loginChip,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.loginChipText}>Log in</Text>
              </Pressable>
            </View>
          )}

          {comments.length === 0 ? (
            <Text style={styles.note}>
              No comments yet — be the first to say something.
            </Text>
          ) : (
            comments.map((comment) => {
              const author = comment.author;
              const name = author
                ? author.displayName || author.username
                : 'Deleted user';
              return (
                <View key={comment.id} style={styles.row}>
                  {author ? (
                    <Pressable
                      onPress={() =>
                        router.push(`/user/${author.username}`)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${name}'s profile`}
                      hitSlop={4}
                    >
                      <Avatar
                        url={author.avatarUrl}
                        name={name}
                        seed={author.id}
                        size={36}
                      />
                    </Pressable>
                  ) : (
                    <Avatar url={null} name="?" size={36} />
                  )}
                  <View style={styles.rowMain}>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      <Text
                        style={[
                          styles.rowName,
                          !author && styles.rowNameGhost,
                        ]}
                      >
                        {name}
                      </Text>
                      {'  ·  '}
                      {relativeTime(comment.createdAt)}
                    </Text>
                    <Text style={styles.rowText}>{comment.content}</Text>
                  </View>
                </View>
              );
            })
          )}

          {/* Load-more footer (fix batch 2026-11-11): while
              more pages exist the footer is a spinner during an
              in-flight page fetch, otherwise a "Load more"
              affordance — the load itself is also triggered from
              the sentinel Pressable's onLayout, which fires as
              the parent ScrollView lays the section's tail into
              the rendered window (the onEndReached equivalent
              for a section embedded in a ScrollView). */}
          {hasMore && (
            <Pressable
              onPress={loadMore}
              onLayout={() => loadMore()}
              disabled={loadingMore}
              accessibilityRole="button"
              accessibilityLabel="Load more comments"
              accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
              style={styles.loadMoreFooter}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color={theme.accent} />
              ) : (
                <Text style={styles.loadMoreText}>Load more comments</Text>
              )}
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    section: {
      marginTop: spacing.xl,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    heading: {
      ...typeStyles.heading,
      color: theme.text,
    },
    count: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
    },
    loading: {
      paddingVertical: spacing.lg,
      alignItems: 'center',
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      lineHeight: 18,
    },
    composer: {
      marginBottom: spacing.sm,
    },
    composerField: {
      // Detail v7 mock: white card holding [avatar] [lavender pill
      // input] [round mauve send].
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.cardLg,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm,
    },
    composerInputWrap: {
      flex: 1,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    composerInput: {
      ...typeStyles.body,
      color: theme.text,
      maxHeight: 96,
      paddingVertical: 2,
    },
    sendTile: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendTileDisabled: {
      opacity: 0.45,
    },
    composerMeta: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.md,
      marginTop: spacing.xs + 2,
    },
    counter: {
      ...typeStyles.caption,
      color: theme.muted,
      marginLeft: 'auto',
    },
    counterOver: {
      color: theme.accent,
    },
    loginPrompt: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    loginChip: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    loginChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    row: {
      // Detail v7 mock: each comment is its own white card.
      flexDirection: 'row',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.cardLg,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    rowMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    rowName: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    rowNameGhost: {
      color: theme.muted,
      fontStyle: 'italic',
    },
    rowText: {
      ...typeStyles.body,
      fontSize: 13,
      color: theme.text,
      lineHeight: 18,
    },
    pressed: {
      opacity: 0.85,
    },
    loadMoreFooter: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.md,
      marginBottom: spacing.sm,
    },
    loadMoreText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
  });
