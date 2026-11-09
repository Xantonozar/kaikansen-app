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
  ChevronLeft,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
} from 'lucide-react-native';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';
import { ApiError, requestPasswordReset, resetPasswordWithCode } from '../authApi';
import { FORM_MAX_WIDTH } from '../layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

// The brand glyph (the splash asset) — the same asset AuthForm draws.
const GLYPH = require('../../assets/splash-icon.png');

/**
 * Forgot / Reset password — the code-based flow behind Login's
 * "Forgot password?" link.
 *
 * DESIGN SOURCE: the Login mock draws the link, but NO dedicated
 * Forgot/Reset screen design exists in the Stitch set (checked the
 * handoff pack + the downloaded HTML) — so these steps are built in
 * the established AuthForm patterns (brand header, lavender fields,
 * pill primary, visibility eyes) as a deliberate interpretation.
 *
 * The flow NEVER reveals account existence: the email step advances
 * to the code step on the API's generic 200 whatever the address,
 * and the code step's copy stays conditional ("if an account
 * exists…"). Code failures surface the API's generic message.
 *
 * Demo mode cannot send email (there is no API): submitting the
 * email step shows exactly that instead of faking a send, and the
 * code step is never reached.
 */
export function ForgotPasswordForm() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { demoMode } = useAuth();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  };

  const submitEmail = async () => {
    if (busy) return;
    setError(null);
    setNote(null);
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    if (demoMode) {
      // Honest demo state: no API, no email — say so, never fake it.
      setNote(
        'Demo mode can’t send email — password reset needs the live API, so no code was sent.',
      );
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset({ email: email.trim() });
      // The API answers identically whether or not the account
      // exists — advancing unconditionally is the honest mirror.
      setStep('code');
    } catch (e: unknown) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await requestPasswordReset({ email: email.trim() });
      setNote(
        'If an account exists for this email, a new code is on its way.',
      );
    } catch (e: unknown) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async () => {
    if (busy) return;
    setError(null);
    setNote(null);
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    if (!newPassword) {
      setError('Enter a new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords don’t match.');
      return;
    }
    setBusy(true);
    try {
      await resetPasswordWithCode({
        email: email.trim(),
        code: cleanCode,
        newPassword,
      });
      router.replace({
        pathname: '/login',
        params: { notice: 'Password reset — log in with your new password.' },
      });
    } catch (e: unknown) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Could not reach the server. Check your connection and try again.',
      );
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

  const eye = (shown: boolean, toggle: () => void, label: string) => (
    <Pressable
      onPress={toggle}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.eyeHit}
    >
      {shown ? (
        <EyeOff size={18} color={theme.muted} strokeWidth={2} />
      ) : (
        <Eye size={18} color={theme.muted} strokeWidth={2} />
      )}
    </Pressable>
  );

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

          <View style={styles.brand}>
            <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
            <Text style={styles.brandName}>KAIKANSEN</Text>
            <Text style={styles.tagline}>Anime openings &amp; endings</Text>
          </View>

          {step === 'email' ? (
            <>
              <Text style={styles.heading}>Reset your password</Text>
              <Text style={styles.subheading}>
                Enter your account email and we’ll send you a 6-digit reset
                code.
              </Text>

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
                  returnKeyType="go"
                  onSubmitEditing={() => void submitEmail()}
                />,
              )}

              {error !== null && <Text style={styles.error}>{error}</Text>}
              {note !== null && <Text style={styles.note}>{note}</Text>}

              <Pressable
                onPress={() => void submitEmail()}
                disabled={busy}
                style={[styles.primary, busy && styles.disabled]}
                accessibilityRole="button"
              >
                {busy ? (
                  <ActivityIndicator color={theme.onAccent} />
                ) : (
                  <Text style={styles.primaryLabel}>Send reset code</Text>
                )}
              </Pressable>

              {demoMode && (
                <Text style={styles.note}>
                  Demo mode — connect an API to use real accounts
                </Text>
              )}
            </>
          ) : (
            <>
              <Text style={styles.heading}>Enter your code</Text>
              <Text style={styles.subheading}>
                If an account exists for {email.trim()}, a 6-digit code is on
                its way. It expires in 15 minutes.
              </Text>

              {field(
                'code',
                'Reset code',
                KeyRound,
                <TextInput
                  style={styles.input}
                  value={code}
                  onChangeText={setCode}
                  onFocus={() => setFocused('code')}
                  onBlur={() => setFocused(null)}
                  placeholder="123456"
                  placeholderTextColor={theme.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="next"
                />,
              )}

              {field(
                'newPassword',
                'New password',
                Lock,
                <TextInput
                  style={styles.input}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  onFocus={() => setFocused('newPassword')}
                  onBlur={() => setFocused(null)}
                  placeholder="Your new password"
                  placeholderTextColor={theme.muted}
                  secureTextEntry={!showNew}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />,
                eye(showNew, () => setShowNew((v) => !v), showNew ? 'Hide new password' : 'Show new password'),
              )}

              {field(
                'confirmPassword',
                'Confirm new password',
                Lock,
                <TextInput
                  style={styles.input}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  onFocus={() => setFocused('confirmPassword')}
                  onBlur={() => setFocused(null)}
                  placeholder="Repeat the new password"
                  placeholderTextColor={theme.muted}
                  secureTextEntry={!showConfirm}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={() => void submitReset()}
                />,
                eye(showConfirm, () => setShowConfirm((v) => !v), showConfirm ? 'Hide confirmation' : 'Show confirmation'),
              )}

              {error !== null && <Text style={styles.error}>{error}</Text>}
              {note !== null && <Text style={styles.note}>{note}</Text>}

              <Pressable
                onPress={() => void submitReset()}
                disabled={busy}
                style={[styles.primary, busy && styles.disabled]}
                accessibilityRole="button"
              >
                {busy ? (
                  <ActivityIndicator color={theme.onAccent} />
                ) : (
                  <Text style={styles.primaryLabel}>Reset password</Text>
                )}
              </Pressable>

              <Pressable
                onPress={() => void resendCode()}
                disabled={busy}
                style={styles.footer}
                accessibilityRole="button"
              >
                <Text style={styles.footerText}>
                  No code yet?{' '}
                  <Text style={styles.footerStrong}>Send a new one</Text>
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setStep('email');
                  setError(null);
                  setNote(null);
                }}
                style={styles.footer}
                accessibilityRole="button"
              >
                <Text style={styles.footerText}>
                  Wrong email? <Text style={styles.footerStrong}>Go back</Text>
                </Text>
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
    label: {
      ...typeStyles.caption,
      color: theme.muted,
      marginBottom: spacing.xs,
      marginTop: spacing.md,
    },
    fieldBox: {
      // Same lavender field treatment as Login/Register.
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
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.md,
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
