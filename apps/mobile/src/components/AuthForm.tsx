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
import { useRouter } from 'expo-router';
import {
  AtSign,
  ChevronLeft,
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
 * NO Forgot password link: the design draws one, but the web has
 * NO password-reset capability at all — its LoginForm links to a
 * /forgot-password page that does not exist, there is no API
 * route and no email pipeline anywhere in the web codebase
 * (verified in kaisen-src, Slice 6). A dead link is not drawn;
 * flagged for ozar's decision in the Slice 6 report.
 *
 * Compact/icon-led chrome (approved mockup v1): a tile back button,
 * a leading glyph inside each field, pill-shaped actions, and the
 * form column capped and centred on wide viewports. The fields,
 * validation and submit flow are unchanged.
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

          {!isLogin && (
            <>
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
              {field(
                'displayName',
                'Display name (optional)',
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
      width: '100%',
      maxWidth: FORM_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xxxl,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
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
      // Login/Register mocks: fields are pale lavender fills.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: 'transparent',
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
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.pill,
      minHeight: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.lg,
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
