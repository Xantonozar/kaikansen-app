import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
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
import Svg, { Path } from 'react-native-svg';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AtSign,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { AppImage } from './AppImage';
import { useAuth } from '../auth';
import { FORM_MAX_WIDTH } from '../layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

// The brand glyph (the splash asset) — the same asset file the
// AniList handoff screen draws. Per the owner's asset ruling this
// is the LATEST logo (the brush-calligraphy K); the auth mocks'
// composited sakura-petal/play glyph is retired and never drawn.
const GLYPH = require('../../assets/splash-icon.png');

/**
 * The ORIGINAL AniList logo mark, drawn as vector paths (the
 * owner's ruling: the AniList button keeps AniList's own icon).
 * No AniList image asset ships in the repo — the previous build
 * substituted a blue tile with a letter "A", which the Login
 * fidelity slice replaced with the mark's real geometry, copied
 * path-for-path from the official logo (the same paths the
 * Stitch Login HTML embeds). The fills are AniList's brand blues
 * (#02A9FF, with the crossbar segment in #0080C0 at 30%) — a
 * brand-asset exception to the Lavender Dusk tokens, exactly as
 * the mock draws it, in both themes.
 */
function AnilistMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6.36 18.57H2.08L8.64 5.43H12.92L6.36 18.57Z"
        fill="#02A9FF"
      />
      <Path
        d="M12.92 5.43H8.64L10.78 9.71H15.06L12.92 5.43Z"
        fill="#0080C0"
        opacity={0.3}
      />
      <Path d="M14.07 18.57H21.92V14.43H14.07V18.57Z" fill="#02A9FF" />
      <Path d="M14.07 12.28H18.21V8.14H14.07V12.28Z" fill="#02A9FF" />
    </Svg>
  );
}

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
 * Login fidelity slice (2026-11-10): the presentation was
 * re-measured against the Stitch Login HTML — 24pt side padding,
 * 52pt fields at an 18pt radius with 20pt mauve leading icons,
 * 12.5pt semibold labels, the 26pt welcome heading, 52pt pill
 * actions, the 'or' divider at 20pt margins, and the AniList
 * button carrying the ORIGINAL AniList logo mark (see AnilistMark)
 * on a white fill. The styles are shared with Register mode.
 * Behaviour — state, validation, submit, the AniList flow incl.
 * its dismissAll landing — is untouched.
 *
 * Register fidelity slice (2026-11-10): Register mode was
 * verified against the Stitch Register HTML, whose values
 * DIVERGE from the Login HTML on the shared chrome: a 64pt glyph
 * (vs Login's 84), a 13pt wordmark at 0.22em tracking (17pt /
 * 0.24em), a 24pt heading (26pt), 12pt labels (12.5pt) on a 14pt
 * form rhythm (16pt), 50pt fields at a 16pt radius (52pt / 18pt),
 * a 50pt primary with a 14pt label (15pt), a 46pt AniList button
 * with a 14pt medium label (52pt / 14.5pt semibold) and a 12pt
 * medium footer (13pt). Each divergent value applies in Register
 * mode ONLY, via createStyles' `register` flag — Login's
 * rendering is exactly what the Login slice left. Two
 * Register-only layout points: the column's top padding is 32
 * (the Register HTML's py-8; Login keeps its 20), and the footer
 * is PINNED to the bottom — the Register HTML lays its column
 * out justify-between at full height — via a flexGrow +
 * space-between content container over a [form cluster, footer]
 * child split; Login's footer flows 28pt under the AniList
 * button as before. The Register HTML also gives the password
 * field a "Your password" placeholder (Login's HTML gives
 * bullets; each mode follows its own), and its Display name /
 * Username placeholders are the owner's own name and handle
 * ("Zadid" / "zadid") — persona example content in the design,
 * shipped as drawn and flagged in the slice report. The Register
 * HTML's decorative top glow and the buttons' soft shadows are
 * not reproduced (no token covers them; the Login slice made
 * the same call on shadows). Behaviour is untouched.
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
  const styles = useMemo(
    () => createStyles(theme, mode === 'register'),
    [theme, mode],
  );
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

  /**
   * AniList success lands on the shell AFFIRMATIVELY, unlike the
   * password path's single relative pop above. The AniList flow
   * pushes the handoff screen mid-flight, and the provider pops
   * it on settle only best-effort (src/auth.tsx: the pop is gated
   * on the handoff screen's mounted registration in
   * src/anilistHandoff.ts). So when loginWithAnilist resolves,
   * the stack may be [shell, login] or [shell, login, handoff] —
   * and a relative back() pops whichever screen happens to be on
   * top: the handoff instead of this screen when the provider's
   * pop was skipped, leaving the user on the login form after a
   * successful sign-in (the owner-reported bug). Dismissing
   * every pushed screen returns to the (drawer) shell — whose
   * first tab is Home — in both shapes.
   */
  const landOnShell = () => {
    if (router.canDismiss()) router.dismissAll();
    else goBack();
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
        {/* Login HTML: 20px field glyphs in the mauve #8E5B7B
            (theme.secondary), at the field's left-4 inset. */}
        <Icon size={20} color={theme.secondary} strokeWidth={2} />
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
      landOnShell();
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
          <View>
            {/* No back chevron (design polish pass): the Login /
                Register mocks open straight on the brand header —
                the screens are reached from, and return to, the
                tabs via the footer cross-link and post-submit. */}

            {/* Brand header (Login/Register mocks, Slice 6): the
                real glyph, the tracked KAIKANSEN wordmark and the
                tagline — replacing the plain wordmark text. */}
            <View style={styles.brand}>
              <AppImage source={GLYPH} style={styles.glyph} resizeMode="contain" />
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
                placeholder={isLogin ? '••••••••••••' : 'Your password'}
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
                  <EyeOff size={20} color={theme.secondary} strokeWidth={2} />
                ) : (
                  <Eye size={20} color={theme.secondary} strokeWidth={2} />
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
                  {/* The ORIGINAL AniList logo mark (owner's ruling),
                      drawn as vector paths — see AnilistMark above. */}
                  <AnilistMark />
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

          </View>
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

const createStyles = (theme: Theme, register: boolean) =>
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
      // Login HTML: the column pads px-6 (the cap stays the shared
      // FORM_MAX_WIDTH — inert on phones, and shared with the
      // forgot-password and quiz forms).
      paddingHorizontal: spacing.xxl,
      // Register HTML: the column pads py-8 (Login keeps its 20).
      paddingTop: register ? spacing.xxxl : spacing.xl,
      paddingBottom: spacing.xxxl,
      // Register HTML: the column runs justify-between at full
      // height with the footer pinned to the bottom — flexGrow +
      // space-between over the [form cluster, footer] children.
      // Login's footer flows in the column (flex-start), as the
      // Login slice left it.
      flexGrow: 1,
      justifyContent: register ? 'space-between' : 'flex-start',
    },
    brand: {
      alignItems: 'center',
      // Both HTMLs: header mb-6. Register HTML: header mt-2.
      marginTop: register ? spacing.sm : 0,
      marginBottom: spacing.xxl,
    },
    glyph: {
      // The brush-K splash asset in the mock's brand slot — the
      // size the auth screens already carried (the Login mock's
      // glyph box, 110×78, framed its wide retired sakura mark;
      // the square brush-K keeps the established 84). Register
      // HTML: the glyph box is w-16 h-16 (64).
      width: register ? 64 : 84,
      height: register ? 64 : 84,
    },
    brandName: {
      fontFamily: 'Outfit_800ExtraBold',
      // Login HTML: 17px extrabold, tracking 0.24em (≈4 at 17pt),
      // glyph block mb-3. Register HTML: 13px extrabold, tracking
      // 0.22em (≈2.9 at 13pt), glyph block mb-2.5 (10 — literal,
      // cited; no spacing token at 10).
      fontSize: register ? 13 : 17,
      letterSpacing: register ? 2.9 : 4,
      color: theme.text,
      marginTop: register ? 10 : spacing.md,
    },
    tagline: {
      ...typeStyles.bodySmall,
      // Login HTML: 12.5px medium in the mauve #8E5B7B, tracking
      // wide. Register HTML: 12px medium in #8E6D80 (maps to the
      // secondary token), tracking tight (≈-0.3 at 12pt).
      fontSize: register ? 12 : 12.5,
      letterSpacing: register ? -0.3 : 0,
      fontFamily: 'Inter_500Medium',
      color: theme.secondary,
      marginTop: spacing.xs,
    },
    heading: {
      // Login HTML: 26px bold, tracking-tight. Per DESIGN.md the
      // app's display face is Outfit (700 loaded), standing in for
      // the HTML's Plus Jakarta Sans — the same substitution the
      // AniList handoff slice recorded.
      fontFamily: fontFamilies.display,
      // Register HTML: the heading is text-2xl (24px) bold.
      fontSize: register ? 24 : 26,
      letterSpacing: -0.5,
      color: theme.text,
      textAlign: 'center',
    },
    subheading: {
      ...typeStyles.body,
      // Register HTML: the subheading is 13px medium (Login's is
      // 14px regular, from typeStyles.body above).
      fontSize: register ? 13 : 14,
      fontFamily: register ? 'Inter_500Medium' : 'Inter_400Regular',
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.xs,
      // With the first label's marginTop this lands the heading
      // block's mb-6 (24) from the Login HTML (8 + 16); the
      // Register HTML's mb-6 lands as 10 + its 14pt form rhythm.
      marginBottom: register ? 10 : spacing.sm,
    },
    eyeHit: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    forgotHit: {
      alignSelf: 'flex-end',
      // Login HTML: the link row follows the password field at
      // the form's gap-4 (its own -mt-0.5 nets ≈14 to the text).
      marginTop: spacing.sm,
      paddingVertical: spacing.xs,
      paddingHorizontal: 2,
    },
    forgotText: {
      ...typeStyles.bodySmall,
      // Login HTML: 12.5px medium in the mauve #8E5B7B.
      fontSize: 12.5,
      fontFamily: 'Inter_500Medium',
      color: theme.secondary,
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
      // Login HTML: the divider block is my-5.
      marginTop: spacing.xl,
    },
    orLine: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    orText: {
      ...typeStyles.bodySmall,
      // Login HTML: 12.5px medium mauve on the background gap.
      // Register HTML: text-xs (12px) medium (#A08E9A maps to the
      // secondary token, as Login's #8E5B7B does).
      fontSize: register ? 12 : 12.5,
      fontFamily: 'Inter_500Medium',
      color: theme.secondary,
    },
    label: {
      ...typeStyles.caption,
      // Login HTML: 12.5px semibold, tracking-wide, pl-1, with the
      // form's gap-1.5 under and gap-4 above (the HTML's muted
      // #786872 maps to the muted token). Register HTML: text-xs
      // (12px) semibold, no tracking, mb-1.5 under, on the form's
      // gap-3.5 rhythm (14 above; #665761 maps to the muted
      // token).
      fontSize: register ? 12 : 12.5,
      fontFamily: 'Inter_600SemiBold',
      letterSpacing: register ? 0 : 0.3,
      color: theme.muted,
      marginLeft: spacing.xs,
      marginBottom: 6,
      marginTop: register ? 14 : spacing.lg,
    },
    fieldBox: {
      // Login/Register mocks (design polish pass): fields are
      // WHITE-filled with a hairline border — the earlier
      // lavender fill was the audit's delta. Focus still draws
      // the accent border. Login HTML measurements: h-[52px],
      // rounded-[18px] (no radius token at 18 — literal, cited);
      // Register HTML: rounded-2xl, 50 tall (the `register`
      // ternaries below). Both: icon inset left-4 with the input
      // at pl-12 (16 + 20 glyph
      // + 12 gap).
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      // Register HTML: fields are rounded-2xl (16) and measure
      // 50 tall (py-3.5 around the input's 22pt line).
      borderRadius: register ? radii.md : 18,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: spacing.lg,
      minHeight: register ? 50 : 52,
    },
    fieldBoxFocused: {
      borderColor: theme.accent,
    },
    input: {
      flex: 1,
      ...typeStyles.body,
      // Login HTML: field text is 14.5px. Register HTML:
      // text-body-md (14px).
      fontSize: register ? 14 : 14.5,
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
      // Login HTML: h-[52px]. Register HTML: py-3.5 (50 tall),
      // following the password field at the form's gap-3.5 plus
      // the button's mt-2 (22 — literal, cited; no token at 22).
      minHeight: register ? 50 : 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: register ? 22 : spacing.xl,
    },
    disabled: {
      opacity: 0.6,
    },
    primaryLabel: {
      ...typeStyles.body,
      // Login HTML: 15px bold — Inter 600 is the heaviest loaded
      // Inter face, so semibold carries it (as on every other
      // button in the app). Register HTML: text-body-md (14px)
      // semibold.
      fontSize: register ? 14 : 15,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccent,
    },
    ghost: {
      flexDirection: 'row',
      // Login HTML: gap-2.5 between the mark and the label
      // (no spacing token at 10 — literal, cited).
      gap: 10,
      // Login HTML: the AniList button is WHITE-filled.
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.pill,
      // Login HTML: h-[52px], under the divider's my-5. Register
      // HTML: py-3 (46 tall), under the same my-5.
      minHeight: register ? 46 : 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xl,
    },
    ghostLabel: {
      ...typeStyles.body,
      // Login HTML: 14.5px semibold ink. Register HTML:
      // text-body-md (14px) medium ink.
      fontSize: register ? 14 : 14.5,
      fontFamily: register ? 'Inter_500Medium' : 'Inter_600SemiBold',
      color: theme.text,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.md,
    },
    footer: {
      // Login HTML: the footer prompt sits mt-7 (no spacing token
      // at 28 — literal, cited). Register HTML: pt-6 (24) is the
      // MINIMUM gap — the space-between column pins the footer to
      // the bottom on taller screens.
      marginTop: register ? 24 : 28,
      alignItems: 'center',
    },
    footerText: {
      ...typeStyles.bodySmall,
      // Login HTML: 13px regular. Register HTML: text-xs (12px)
      // medium.
      fontSize: register ? 12 : 13,
      fontFamily: register ? 'Inter_500Medium' : 'Inter_400Regular',
      color: theme.muted,
    },
    footerStrong: {
      // Login HTML: the cross-link is bold deep-mauve (Inter 600,
      // the heaviest loaded face, carries the bold).
      fontFamily: 'Inter_600SemiBold',
      color: theme.accent,
    },
  });
