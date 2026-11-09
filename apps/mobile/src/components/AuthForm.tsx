import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AtSign,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from 'lucide-react-native';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';
import { FORM_MAX_WIDTH } from '../layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

// The brand glyph (the splash asset) — the same asset file the
// AniList handoff screen draws.
const GLYPH = require('../../assets/splash-icon.png');

/**
 * Login / Register form (DESIGN.md §6.1/§6.2): the mocks' brand
 * header (real glyph + tracked KAIKANSEN + tagline, Slice 6), the
 * web-pattern fields, one primary action, the AniList entry point, and
 * the cross-link to the sibling screen. Inputs follow §7 — surface
 * fill, radius base, muted placeholder, accent border on focus.
 *
 * The "Forgot password?" link (login only, right-aligned under
 * the password field — the position the Login mock draws) was
 * deliberately NOT drawn while the web had no password-reset
 * capability at all (Slice 6 finding). ozar then decided to build
 * the capability (2026-11-09): the API now has code-based
 * forgot/reset endpoints with Brevo email, so the link is drawn
 * and routes to /forgot-password. A `?notice=` param (set by the
 * reset flow on success) renders as a confirmation line here.
 *
 * Compact/icon-led chrome (approved mockup v1): a leading glyph
 * inside each field, pill-shaped actions, and the form column
 * capped and centred on wide viewports. The fields, validation
 * and submit flow are unchanged. (Design polish pass: no back
 * chevron, white-filled fields, Register order Display name →
 * Username → Email → Password, AniList button carries the logo
 * mark.)
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
  const { notice } = useLocalSearchParams<{ notice?: string }>();
  const { login, register, loginWithAnilist, demoMode } = useAuth();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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

  const fieldBoxStyle = (name: string) => [
    styles.fieldBox,
    focused === name && styles.fieldBoxFocused,
  ];

  /** A labelled field: leading glyph + input inside one surface box. */
  const field = (
    name: string,
    label: string,
    Icon: IconComponent,
    input: ReactNode,
    trailing?: ReactNode,
  ) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={fieldBoxStyle(name)}>
        <Icon size={18} color={theme.muted} strokeWidth={2} />
        {input}
        {trailing}
      </View>
    </>
  );

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
          {/* No back chevron (design polish pass): the Login /
              Register mocks open straight on the brand header —
              the screens are reached from, and return to, the
              tabs via the footer cross-link and post-submit. */}

          {/* Brand header (Login/Register mocks, Slice 6): the
              real glyph, the tracked KAIKANSEN wordmark and the
              tagline — replacing the plain wordmark text. */}
          <View style={styles.brand}>
            <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
            <Text style={styles.brandName}>KAIKANSEN</Text>
            <Text style={styles.tagline}>Anime openings &amp; endings</Text>
          </View>
          <Text style={styles.heading}>
            {isLogin ? 'Welcome back' : 'Create your account'}
          </Text>
          <Text style={styles.subheading}>
            {isLogin
              ? 'Log in to keep listening.'
              : 'Join Kaikansen to save themes and play quizzes.'}
          </Text>

          {/* Post-reset confirmation, handed back by /forgot-password. */}
          {isLogin && notice ? (
            <Text style={styles.successNote}>{notice}</Text>
          ) : null}

          {!isLogin && (
            <>
              {/* Register field order per the mock (design polish
                  pass): Display name → Username → Email → Password.
                  The "(optional)" suffix is dropped from the label
                  — display name stays optional in the payload
                  (empty submits as undefined, as before). */}
              {field(
                'displayName',
                'Display name',
                User,
                <TextInput
                  style={styles.input}
                  value={displayName}
                  onChangeText={setDisplayName}
                  onFocus={() => setFocused('displayName')}
                  onBlur={() => setFocused(null)}
                  placeholder="Zadid"
                  placeholderTextColor={theme.muted}
                  autoCorrect={false}
                  returnKeyType="next"
                />,
              )}
              {field(
                'username',
                'Username',
                AtSign,
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  onFocus={() => setFocused('username')}
                  onBlur={() => setFocused(null)}
                  placeholder="zadid"
                  placeholderTextColor={theme.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />,
              )}
            </>
          )}

          {field(
            'email',
            'Email',
            Mail,
            <TextInput
              style={styles.input}
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
            />,
          )}

          {field(
            'password',
            'Password',
            Lock,
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              placeholder="Your password"
              placeholderTextColor={theme.muted}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />,
            // The mocks' visibility eye — a real toggle.
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                showPassword ? 'Hide password' : 'Show password'
              }
              style={styles.eyeHit}
            >
              {showPassword ? (
                <EyeOff size={18} color={theme.muted} strokeWidth={2} />
              ) : (
                <Eye size={18} color={theme.muted} strokeWidth={2} />
              )}
            </Pressable>,
          )}

          {/* The Login mock's Forgot password link: right-aligned,
              small, mauve — under the password field, above Log in. */}
          {isLogin && (
            <Pressable
              onPress={() => router.push('/forgot-password')}
              style={styles.forgotHit}
              accessibilityRole="button"
            >
              <Text style={styles.forgotText}>Forgot password?</Text>
            </Pressable>
          )}

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

          {/* The mocks' 'or' divider between the form and AniList. */}
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.orLine} />
          </View>

          <Pressable
            onPress={() => void onAnilist()}
            disabled={anilistBusy}
            style={[styles.ghost, anilistBusy && styles.disabled]}
            accessibilityRole="button"
          >
            {anilistBusy ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <>
                {/* The mock's AniList logo mark. No AniList asset
                    ships in the repo, so the mark is drawn: the
                    brand's blue tile with its initial (a brand
                    constant, like the media blacks in playback). */}
                <View style={styles.anilistMark}>
                  <Text style={styles.anilistMarkText}>A</Text>
                </View>
                <Text style={styles.ghostLabel}>Continue with AniList</Text>
              </>
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
      width: '100%',
      maxWidth: FORM_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.xl,
      paddingBottom: spacing.xxxl,
    },
    brand: {
      alignItems: 'center',
      marginBottom: spacing.xl,
    },
    glyph: {
      width: 84,
      height: 84,
    },
    brandName: {
      fontFamily: 'Outfit_800ExtraBold',
      fontSize: 17,
      letterSpacing: 4,
      color: theme.text,
      marginTop: spacing.sm,
    },
    tagline: {
      ...typeStyles.bodySmall,
      fontFamily: 'Inter_500Medium',
      color: theme.secondary,
      marginTop: spacing.xs,
    },
    heading: {
      ...typeStyles.heading,
      fontSize: 24,
      color: theme.text,
      textAlign: 'center',
    },
    subheading: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.xs,
      marginBottom: spacing.lg,
    },
    eyeHit: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    forgotHit: {
      alignSelf: 'flex-end',
      marginTop: spacing.xs,
      paddingVertical: spacing.xs,
      paddingHorizontal: 2,
    },
    forgotText: {
      ...typeStyles.bodySmall,
      fontFamily: 'Inter_500Medium',
      color: theme.accent,
    },
    successNote: {
      ...typeStyles.bodySmall,
      fontFamily: 'Inter_500Medium',
      color: theme.success,
      textAlign: 'center',
      marginBottom: spacing.lg,
    },
    orRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.lg,
    },
    orLine: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    orText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    label: {
      ...typeStyles.caption,
      color: theme.muted,
      marginBottom: spacing.xs,
      marginTop: spacing.md,
    },
    fieldBox: {
      // Login/Register mocks (design polish pass): fields are
      // WHITE-filled with a hairline border — the earlier
      // lavender fill was the audit's delta. Focus still draws
      // the accent border.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: spacing.md,
      minHeight: 50,
    },
    fieldBoxFocused: {
      borderColor: theme.accent,
    },
    input: {
      flex: 1,
      ...typeStyles.body,
      color: theme.text,
      paddingVertical: spacing.sm,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.danger,
      marginTop: spacing.lg,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      minHeight: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xl,
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
      flexDirection: 'row',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.pill,
      minHeight: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.lg,
    },
    anilistMark: {
      width: 20,
      height: 20,
      borderRadius: 5,
      backgroundColor: '#02A9FF',
      alignItems: 'center',
      justifyContent: 'center',
    },
    anilistMarkText: {
      fontFamily: 'Inter_700Bold',
      fontSize: 12,
      color: '#FFFFFF',
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
      marginTop: spacing.xl,
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
