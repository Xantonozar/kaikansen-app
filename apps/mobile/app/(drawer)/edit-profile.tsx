import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AppImage } from '../../src/components/AppImage';
import type { ImageSource as ExpoImageSource } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Camera,
  Check,
  ChevronLeft,
  Image as ImageIcon,
} from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { useAuth } from '../../src/auth';
import { Avatar } from '../../src/components/Avatar';
import {
  DEFAULT_AVATARS,
  DEFAULT_AVATAR_URLS,
} from '../../src/defaultAvatars';
import { updateMyProfile } from '../../src/socialApi';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Edit Profile (DESIGN.md §6.28, layout-fidelity Slice 4) — the
 * standalone screen replacing the inline Settings card (Slice M5).
 * One save writes through PATCH /auth/me and the response replaces
 * the session profile, so Settings, the header and the drawer
 * reflect it immediately.
 *
 * Field parity with the web's EditProfileClient, checked against
 * its source:
 * - Avatar: the web has NO upload endpoint — its form is an avatar
 *   URL field behind the camera affordance. The badge and "Change
 *   photo" here open the same URL field; saving sends the trimmed
 *   URL, or null (cleared) when emptied. Under the field sits the
 *   defaults picker (owner's order, 2026-11-10): the 10 bundled
 *   chibis rendered from their local assets; tapping one saves
 *   THAT chibi's hosted Cloudinary URL as the avatarUrl right
 *   away (a partial PATCH — the form's other fields are not
 *   written), so the stored value is a plain image URL the
 *   website renders like any other avatar.
 * - Username is read-only — the web's form fixes it ("Usernames
 *   cannot be changed"); when an AniList account is linked, the
 *   design's note names it instead.
 * - Bio caps at 200 (the web's schema), display name at 1–50.
 * - Public profile: the switch writes the user record's real
 *   isPublic flag (API-accepted since Slice 4). Its effect is the
 *   web's own: people search only returns public profiles — the
 *   web gates nothing else on it, and neither does the app.
 */
export default function EditProfileScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user, anilistUsername, updateUser } = useAuth();

  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userId = user?.id;
  useEffect(() => {
    if (user) {
      setEditName(user.displayName);
      setEditBio(user.bio);
      setEditAvatar(user.avatarUrl ?? '');
      setIsPublic(user.isPublic);
      setPhotoOpen(false);
      setError(null);
      setSaved(false);
    }
    // Re-seed only when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(
    () => () => {
      if (backTimer.current) clearTimeout(backTimer.current);
    },
    [],
  );

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const onSave = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const avatar = editAvatar.trim();
    updateMyProfile({
      displayName: editName,
      bio: editBio,
      avatarUrl: avatar.length > 0 ? avatar : null,
      isPublic,
    })
      .then((updated) => {
        updateUser(updated);
        setSaved(true);
        // The web returns to settings shortly after its success
        // toast; mirror the beat, then go back.
        backTimer.current = setTimeout(goBack, 800);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof Error ? e.message : 'Could not save your profile.',
        ),
      )
      .finally(() => setBusy(false));
  };

  /**
   * Defaults picker: save the tapped chibi's hosted URL as the
   * avatar — a partial PATCH /auth/me carrying ONLY avatarUrl, so
   * unsaved name/bio edits in the form are never written by a
   * pick. The response replaces the session profile at once and
   * the screen returns to Profile on the same beat as Save. A
   * failed save keeps the old avatar and shows the error.
   */
  const onPickDefault = (index: number) => {
    if (busy || picking !== null || !user) return;
    const url = DEFAULT_AVATAR_URLS[index];
    if (user.avatarUrl === url) {
      // Already the saved picture — just sync the field/preview.
      setEditAvatar(url);
      return;
    }
    setPicking(index);
    setError(null);
    setSaved(false);
    updateMyProfile({ avatarUrl: url })
      .then((updated) => {
        updateUser(updated);
        setEditAvatar(url);
        setSaved(true);
        backTimer.current = setTimeout(goBack, 800);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof Error ? e.message : 'Could not save your profile.',
        ),
      )
      .finally(() => setPicking(null));
  };

  const linkedName = user?.anilist?.username ?? anilistUsername;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Edit Profile</Text>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {status === 'signedIn' && user ? (
            <>
              <View style={styles.avatarBlock}>
                <View style={styles.avatarWrap}>
                  <Avatar
                    url={
                      editAvatar.trim().length > 0 ? editAvatar.trim() : null
                    }
                    name={editName || user.username}
                    seed={user.id}
                    size={92}
                  />
                  <Pressable
                    onPress={() => setPhotoOpen((open) => !open)}
                    accessibilityRole="button"
                    accessibilityLabel="Change photo"
                    style={({ pressed }) => [
                      styles.cameraBadge,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Camera size={15} color={theme.onAccent} strokeWidth={2} />
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => setPhotoOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityLabel="Change photo"
                >
                  <Text style={styles.changePhoto}>Change photo</Text>
                </Pressable>
                {photoOpen && (
                  <>
                    <View style={styles.avatarField}>
                      <ImageIcon size={17} color={theme.muted} strokeWidth={2} />
                      <TextInput
                        style={styles.avatarInput}
                        value={editAvatar}
                        onChangeText={setEditAvatar}
                        placeholder="Avatar image URL"
                        placeholderTextColor={theme.muted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        accessibilityLabel="Avatar URL"
                      />
                    </View>
                    <Text style={styles.hint}>
                      Set an avatar URL — the same avatar field the website
                      uses. Leave it empty to clear your photo.
                    </Text>
                    <Text style={styles.pickerLabel}>
                      Or choose a default
                    </Text>
                    <View style={styles.pickerGrid}>
                      {DEFAULT_AVATARS.map((source, i) => {
                        const url = DEFAULT_AVATAR_URLS[i];
                        const selected = editAvatar.trim() === url;
                        return (
                          <Pressable
                            key={url}
                            onPress={() => onPickDefault(i)}
                            disabled={busy || picking !== null}
                            accessibilityRole="button"
                            accessibilityLabel={`Choose default avatar ${i + 1}`}
                            accessibilityState={{ selected }}
                            style={({ pressed }) => [
                              styles.pickerCell,
                              selected && styles.pickerCellSelected,
                              pressed && styles.pressed,
                            ]}
                          >
                            {picking === i ? (
                              <ActivityIndicator
                                size="small"
                                color={theme.accent}
                              />
                            ) : (
                              <AppImage
                                source={source as ExpoImageSource}
                                style={styles.pickerImage}
                              />
                            )}
                            {selected && picking === null && (
                              <View style={styles.pickerCheck}>
                                <Check
                                  size={11}
                                  color={theme.onAccent}
                                  strokeWidth={3}
                                />
                              </View>
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}
              </View>

              <View style={styles.card}>
                <Text style={[styles.fieldLabel, styles.fieldLabelFirst]}>
                  Display name
                </Text>
                <TextInput
                  style={styles.input}
                  value={editName}
                  onChangeText={setEditName}
                  placeholder="Display name"
                  placeholderTextColor={theme.muted}
                  maxLength={60}
                  accessibilityLabel="Display name"
                />

                <Text style={styles.fieldLabel}>Username</Text>
                <View style={styles.readonlyBox}>
                  <Text style={styles.readonlyText}>{user.username}</Text>
                </View>
                <Text style={styles.hint}>
                  {linkedName
                    ? `Your AniList name stays @${linkedName}`
                    : 'Usernames cannot be changed.'}
                </Text>

                <Text style={styles.fieldLabel}>Bio</Text>
                <TextInput
                  style={[styles.input, styles.inputMultiline]}
                  value={editBio}
                  onChangeText={setEditBio}
                  placeholder="Bio"
                  placeholderTextColor={theme.muted}
                  multiline
                  maxLength={240}
                  accessibilityLabel="Bio"
                />
                {/* No character counter (design polish pass):
                    the mock draws none, and the old one lied
                    anyway — it counted to /200 against a real
                    240 limit. */}
              </View>

              <View style={[styles.card, styles.publicCard]}>
                <View style={styles.publicTexts}>
                  <Text style={styles.publicTitle}>Public profile</Text>
                  <Text style={styles.publicSub}>
                    Anyone can see your ratings and playlists
                  </Text>
                </View>
                <Switch
                  value={isPublic}
                  onValueChange={setIsPublic}
                  trackColor={{ false: theme.border, true: theme.accent }}
                  thumbColor={theme.surface}
                  accessibilityLabel="Public profile"
                />
              </View>

              <Pressable
                onPress={onSave}
                disabled={busy}
                style={({ pressed }) => [
                  styles.saveButton,
                  pressed && styles.pressed,
                  busy && styles.saveBusy,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Save changes"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={theme.onAccent} />
                ) : (
                  <Text style={styles.saveText}>Save Changes</Text>
                )}
              </Pressable>
              {saved && <Text style={styles.savedNote}>Profile saved.</Text>}
              {error !== null && <Text style={styles.error}>{error}</Text>}
            </>
          ) : (
            <>
              <Text style={styles.note}>You’re not signed in.</Text>
              <Pressable
                onPress={() => router.replace('/login')}
                style={styles.primary}
                accessibilityRole="button"
              >
                <Text style={styles.primaryLabel}>Log in</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    flex: {
      flex: 1,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    avatarBlock: {
      alignItems: 'center',
      marginTop: spacing.md,
      marginBottom: spacing.lg,
    },
    avatarWrap: {
      position: 'relative',
    },
    cameraBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 30,
      height: 30,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      borderWidth: 2.5,
      borderColor: theme.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    changePhoto: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
      marginTop: spacing.sm,
    },
    avatarField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      alignSelf: 'stretch',
      backgroundColor: theme.surface,
      borderRadius: radii.base,
      paddingHorizontal: spacing.md,
      marginTop: spacing.md,
    },
    avatarInput: {
      flex: 1,
      ...typeStyles.body,
      color: theme.text,
      minHeight: 44,
      paddingVertical: 0,
    },
    pickerLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      alignSelf: 'stretch',
      marginTop: spacing.md,
      marginBottom: spacing.sm,
    },
    pickerGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      alignSelf: 'stretch',
    },
    pickerCell: {
      width: 56,
      height: 56,
      borderRadius: radii.pill,
      borderWidth: 2.5,
      borderColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pickerCellSelected: {
      borderColor: theme.accent,
    },
    pickerImage: {
      width: 48,
      height: 48,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
    },
    pickerCheck: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: 18,
      height: 18,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      borderWidth: 2,
      borderColor: theme.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.md,
      marginBottom: spacing.lg,
    },
    fieldLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginTop: spacing.md,
      marginBottom: spacing.xs + 2,
    },
    fieldLabelFirst: {
      marginTop: 0,
    },
    input: {
      ...typeStyles.body,
      color: theme.text,
      backgroundColor: theme.background,
      borderRadius: radii.base,
      paddingHorizontal: spacing.md,
      minHeight: 46,
      paddingVertical: spacing.sm,
    },
    inputMultiline: {
      minHeight: 76,
      textAlignVertical: 'top',
    },
    readonlyBox: {
      backgroundColor: theme.background,
      borderRadius: radii.base,
      paddingHorizontal: spacing.md,
      minHeight: 46,
      justifyContent: 'center',
    },
    readonlyText: {
      // Normal text colour (design polish pass): the username
      // is a value, not a hint — the box's page-background fill
      // is what marks it read-only.
      ...typeStyles.body,
      color: theme.text,
    },
    hint: {
      ...typeStyles.caption,
      color: theme.muted,
      lineHeight: 16,
      marginTop: spacing.xs + 2,
    },
    publicCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    publicTexts: {
      flex: 1,
      gap: 2,
    },
    publicTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    publicSub: {
      ...typeStyles.caption,
      color: theme.muted,
      lineHeight: 16,
    },
    saveButton: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveBusy: {
      opacity: 0.6,
    },
    saveText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    savedNote: {
      ...typeStyles.bodySmall,
      color: theme.success,
      textAlign: 'center',
      marginTop: spacing.md,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.danger,
      marginTop: spacing.md,
      lineHeight: 18,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.md,
      lineHeight: 16,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.lg,
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    pressed: {
      opacity: 0.85,
    },
  });
