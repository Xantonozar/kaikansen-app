import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';

/**
 * Login / Register form (DESIGN.md §6.1/§6.2): wordmark block, the
 * web-pattern fields, one primary action, the AniList entry point, and
 * the cross-link to the sibling screen. Inputs follow §7 — surface
 * fill, radius base, muted placeholder, accent border on focus.
 *
 * The AniList button runs the real OAuth round-trip in live mode on
 * native (src/anilistAuth.ts + the provider's loginWithAnilist). In
 * fixture mode — and on web, where the custom-scheme auth session
 * cannot come back — pressing it keeps the honest placeholder note
 * rather than pretending to work. In fixture mode the screens carry
 * the demo note — auth then runs against the device-local demo store
 * (src/demoAuth.ts), never the network.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { login, register, loginWithAnilist, demoMode } = useAuth();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [focused, setFocused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anilistBusy, setAnilistBusy] = useState(false);
  const [anilistTapped, setAnilistTapped] = useState(false);

  const isLogin = mode === 'login';

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isLogin) {
        await login(email.trim(), password);
      } else {
        await register({
          username: username.trim(),
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
        });
      }
      goBack();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle = (name: string) => [
    styles.input,
    focused === name && styles.inputFocused,
  ];

  const onAnilist = async () => {
    // Fixture mode has no API to run OAuth against, and web has no
    // custom-scheme auth session to return to — both keep the
    // placeholder note instead of a flow that cannot complete.
    if (demoMode || Platform.OS === 'web') {
      setAnilistTapped(true);
      return;
    }
    if (anilistBusy) return;
    setAnilistBusy(true);
    setError(null);
    try {
      await loginWithAnilist();
      goBack();
    } catch (e: unknown) {
      setError(
        e instanceof Error
          ? e.message
          : 'AniList sign-in failed. Please try again.',
      );
    } finally {
      setAnilistBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable onPress={goBack} hitSlop={8} style={styles.back}>
            <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
          </Pressable>

          <Text style={styles.wordmark}>Kaikansen</Text>
          <Text style={styles.heading}>
            {isLogin ? 'Welcome back' : 'Create your account'}
          </Text>

          {!isLogin && (
            <>
              <Text style={styles.label}>Username</Text>
              <TextInput
                style={fieldStyle('username')}
                value={username}
                onChangeText={setUsername}
                onFocus={() => setFocused('username')}
                onBlur={() => setFocused(null)}
                placeholder="zadid"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
              <Text style={styles.label}>Display name (optional)</Text>
              <TextInput
                style={fieldStyle('displayName')}
                value={displayName}
                onChangeText={setDisplayName}
                onFocus={() => setFocused('displayName')}
                onBlur={() => setFocused(null)}
                placeholder="Zadid"
                placeholderTextColor={theme.muted}
                autoCorrect={false}
                returnKeyType="next"
              />
            </>
          )}

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={fieldStyle('email')}
            value={email}
            onChangeText={setEmail}
            onFocus={() => setFocused('email')}
            onBlur={() => setFocused(null)}
            placeholder="you@example.com"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType="next"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={fieldStyle('password')}
            value={password}
            onChangeText={setPassword}
            onFocus={() => setFocused('password')}
            onBlur={() => setFocused(null)}
            placeholder="Your password"
            placeholderTextColor={theme.muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />

          {error !== null && <Text style={styles.error}>{error}</Text>}

          <Pressable
            onPress={() => void submit()}
            disabled={busy}
            style={[styles.primary, busy && styles.disabled]}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator color={theme.onAccent} />
            ) : (
              <Text style={styles.primaryLabel}>
                {isLogin ? 'Log in' : 'Register'}
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={() => void onAnilist()}
            disabled={anilistBusy}
            style={[styles.ghost, anilistBusy && styles.disabled]}
            accessibilityRole="button"
          >
            {anilistBusy ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <Text style={styles.ghostLabel}>Continue with AniList</Text>
            )}
          </Pressable>
          {anilistTapped && (
            <Text style={styles.note}>
              AniList sign-in isn’t part of this prototype slice yet.
            </Text>
          )}

          {demoMode && (
            <Text style={styles.note}>
              Demo mode — connect an API to use real accounts
            </Text>
          )}

          <Pressable
            onPress={() =>
              router.replace(isLogin ? '/register' : '/login')
            }
            style={styles.footer}
            accessibilityRole="button"
          >
            <Text style={styles.footerText}>
              {isLogin ? (
                <>
                  New here? <Text style={styles.footerStrong}>Create an account</Text>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <Text style={styles.footerStrong}>Log in</Text>
                </>
              )}
            </Text>
          </Pressable>
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
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xxxl,
    },
    back: {
      alignSelf: 'flex-start',
      marginBottom: spacing.lg,
    },
    wordmark: {
      ...typeStyles.wordmark,
      fontSize: 34,
      color: theme.wordmark,
      textAlign: 'center',
    },
    heading: {
      ...typeStyles.heading,
      color: theme.text,
      textAlign: 'center',
      marginTop: spacing.sm,
      marginBottom: spacing.xxl,
    },
    label: {
      ...typeStyles.caption,
      color: theme.muted,
      marginBottom: spacing.xs,
      marginTop: spacing.md,
    },
    input: {
      ...typeStyles.body,
      color: theme.text,
      backgroundColor: theme.surface,
      borderRadius: radii.base,
      borderWidth: 1,
      borderColor: 'transparent',
      paddingHorizontal: spacing.lg,
      minHeight: 52,
    },
    inputFocused: {
      borderColor: theme.accent,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      marginTop: spacing.lg,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xxl,
    },
    disabled: {
      opacity: 0.6,
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccent,
    },
    ghost: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.md,
    },
    ghostLabel: {
      ...typeStyles.body,
      fontFamily: 'Inter_600SemiBold',
      color: theme.text,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.md,
    },
    footer: {
      marginTop: spacing.xxl,
      alignItems: 'center',
    },
    footerText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    footerStrong: {
      color: theme.accent,
    },
  });
