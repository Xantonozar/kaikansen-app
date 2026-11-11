import { useEffect, useMemo } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  Globe,
  Heart,
  Sparkles,
  SquareArrowOutUpRight,
} from 'lucide-react-native';
import {
  ABOUT_CREDITS,
  ABOUT_DESCRIPTION,
  ABOUT_LINKS,
  ABOUT_WHATS_NEW,
  aboutVersionLine,
} from '../../src/aboutContent';
import { aboutUpdateView } from '../../src/appUpdate';
import { installedBuild, useUpdate } from '../../src/appUpdateRuntime';
import { UpdateCard } from '../../src/components/UpdateCard';
import { CONTENT_MAX_WIDTH } from '../../src/layout';
import {
  fontFamilies,
  radii,
  spacing,
  withOpacity,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';

// The app's real brush-K glyph — the same splash asset the
// offline screen renders (owner ruling: auth/offline glyph =
// the latest brush-K logo).
const GLYPH = require('../../assets/splash-icon.png');

/**
 * Short display label for a full URL — "https://kaiseen.vercel.app"
 * → "kaiseen.vercel.app" (the links card shows the site, while the
 * Pressable still opens the full ABOUT_LINKS url).
 */
function linkDisplay(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Credit value for the design's label/value rows — the shipped
 * aboutContent value minus its parenthetical site note, so the
 * compact row reads like the mock ("AnimeThemes", not
 * "AnimeThemes (animethemes.moe)"). Only rows whose label differs
 * from the design's short label are remapped by aboutCreditRows'
 * callers; this trims display, never the source facts.
 */
function creditDisplayValue(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * About (release readiness, 2026-11-11) — the app's real info
 * screen, reached from the Settings version footer and the
 * Settings About row. Everything on it is factual and, where it
 * can be, read at runtime: the version + build come from
 * expo-constants (never hardcoded), the facts live in
 * src/aboutContent.ts (unit-tested), the credits name the real
 * data sources, and the links open in the browser via
 * Linking.openURL — the app's existing pattern (anime detail's
 * AniList row).
 *
 * The App update section doubles as the manual check surface
 * (spec §2/§3): opening About forces a FRESH update check —
 * even if a check already completed or failed this session —
 * and the section then reports the outcome HONESTLY (owner
 * ruling 2026-11-11, after the field report that About claimed
 * "up to date" when the check had actually failed): the shared
 * UpdateCard when an update state is live, "You're on the
 * latest version." ONLY after a check completed with the
 * current verdict, "Couldn't check for updates." + Retry when
 * the check failed, and a neutral "Checking for updates…"
 * while one is in flight (or before the first settles) — never
 * a claim the facts do not back. The mapping is the pure
 * aboutUpdateView seam in src/appUpdate.ts.
 *
 * Layout rebuilt 2026-11-11 to the owner-approved modern About
 * design (Stitch screen 114fd9fc3f4f400aa6f290d010da7d17,
 * measurements from its HTML): white-glass back disc + title in
 * the safe zone, brush-K glyph in a white rounded tile, 24px
 * cards with hairline borders and soft shadows, What's-new rows
 * with circle-checks and a runtime version pill, Credits as
 * label/value rows with the developer footer, and a Links card
 * of icon-disc rows. The design's decorations are kept on the
 * owner's approval (icon discs, pill, sparkle/heart glyphs).
 * Behaviour is unchanged from the previous layout — same state
 * machine, same card, same links; where the mock's copy and the
 * shipped facts differed (credit rows, link rows), the facts
 * won and only the layout follows the mock.
 */
export default function AboutScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { state, check, pressUpdate, pressLater } = useUpdate();
  const build = installedBuild();

  // Forced re-check on open (owner ruling 2026-11-11): About is
  // the surface a user visits to ask "am I current?" — the
  // answer must come from a check run NOW, not from whatever
  // the launch check settled to (or failed to settle) earlier.
  // `force` starts a fresh check from any resting outcome; an
  // in-flight check is joined, never doubled.
  useEffect(() => {
    check({ force: true });
  }, [check]);

  const updateView = aboutUpdateView(state);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  // Credits reshaped to the design's rows: the three source rows
  // (short label → value) and the developer row, which the mock
  // draws as the card footer. Labels come from the design; every
  // value comes from the shipped ABOUT_CREDITS facts.
  const sourceCredits = ABOUT_CREDITS.filter(
    (credit) => credit.label !== 'Developed by',
  );
  const developerCredit = ABOUT_CREDITS.find(
    (credit) => credit.label === 'Developed by',
  );
  const sourceLabels: Record<string, string> = {
    'Theme catalogue & media': 'Themes',
    'Anime data': 'Data',
    'Artwork hosting': 'Images',
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [
            styles.backDisc,
            pressed && styles.pressed,
          ]}
        >
          <ArrowLeft size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>About</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.glyphTile}>
            <Image source={GLYPH} style={styles.glyph} resizeMode="contain" />
          </View>
          <Text style={styles.appName}>Kaikansen</Text>
          <Text style={styles.versionLine}>
            {aboutVersionLine(build.version, build.versionCode)}
          </Text>
          <Text style={styles.description}>{ABOUT_DESCRIPTION}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>App update</Text>
          {updateView === 'card' ? (
            // The shared UpdateCard carries its own card chrome;
            // it sits inset on this section card, exactly as the
            // previous layout had it — the design's available
            // state maps to this card's available phase.
            <UpdateCard
              state={state}
              onUpdate={pressUpdate}
              onLater={pressLater}
            />
          ) : updateView === 'current' ? (
            <Text style={styles.caption}>You’re on the latest version.</Text>
          ) : updateView === 'failed' ? (
            <View style={styles.failedRow}>
              <Text style={styles.caption}>Couldn’t check for updates.</Text>
              <Pressable
                onPress={() => check({ force: true })}
                hitSlop={3}
                accessibilityRole="button"
                accessibilityLabel="Retry update check"
                style={({ pressed }) => [
                  styles.retryHit,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.retryLabel}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.caption}>Checking for updates…</Text>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Sparkles size={18} color={theme.secondary} strokeWidth={2} />
              <Text style={styles.cardTitle}>What’s new</Text>
            </View>
            <View style={styles.versionPill}>
              <Text style={styles.versionPillText}>v{build.version}</Text>
            </View>
          </View>
          <View style={styles.headerDivider} />
          <View style={styles.checkList}>
            {ABOUT_WHATS_NEW.map((line) => (
              <View key={line} style={styles.checkRow}>
                <CircleCheck
                  size={17}
                  color={theme.secondary}
                  strokeWidth={2}
                  style={styles.checkIcon}
                />
                <Text style={styles.checkLine}>{line}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Heart size={18} color={theme.secondary} strokeWidth={2} />
            <Text style={styles.cardTitle}>Credits</Text>
          </View>
          <View style={styles.headerDivider} />
          <View>
            {sourceCredits.map((credit, index) => (
              <View
                key={credit.label}
                style={[
                  styles.creditRow,
                  index < sourceCredits.length - 1 && styles.creditDivider,
                ]}
              >
                <Text style={styles.creditLabel}>
                  {sourceLabels[credit.label] ?? credit.label}
                </Text>
                <Text style={styles.creditValue}>
                  {creditDisplayValue(credit.value)}
                </Text>
              </View>
            ))}
          </View>
          {developerCredit ? (
            <>
              <View style={styles.headerDivider} />
              <Text style={styles.developerLine}>
                Developed by{' '}
                <Text style={styles.developerName}>
                  {creditDisplayValue(developerCredit.value)}
                </Text>
              </Text>
            </>
          ) : null}
        </View>

        <View style={[styles.card, styles.linksCard]}>
          {ABOUT_LINKS.map((link, index) => (
            <View key={link.url}>
              {index > 0 ? <View style={styles.linkDivider} /> : null}
              <Pressable
                onPress={() => void Linking.openURL(link.url)}
                accessibilityRole="link"
                accessibilityLabel={`Open ${link.label}`}
                style={({ pressed }) => [
                  styles.linkRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.linkMain}>
                  <View style={styles.linkDisc}>
                    {link.label === 'AniList' ? (
                      <SquareArrowOutUpRight
                        size={18}
                        color={theme.accent}
                        strokeWidth={2}
                      />
                    ) : (
                      <Globe size={18} color={theme.accent} strokeWidth={2} />
                    )}
                  </View>
                  <Text style={styles.linkLabel} numberOfLines={1}>
                    {link.label}
                    <Text style={styles.linkUrl}>
                      {'  —  '}
                      {linkDisplay(link.url)}
                    </Text>
                  </Text>
                </View>
                <ChevronRight size={18} color={theme.secondary} strokeWidth={2} />
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    topBar: {
      // Header zone (design HTML: px-5, py-3 row): the back disc
      // + title sit BELOW the status bar — SafeAreaView's top
      // edge supplies the inset, this row supplies the mock's
      // own breathing room.
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.md,
      gap: spacing.md,
    },
    backDisc: {
      // network.html/player precedent: 40pt white-glass disc,
      // hairline border, soft shadow, ink arrow at 22.
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: withOpacity(theme.surface, 0.7),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: theme.text,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 3,
      elevation: 1,
    },
    title: {
      // Design HTML: text-xl (20) bold tracking-tight.
      fontFamily: fontFamilies.display,
      fontSize: 20,
      letterSpacing: -0.5,
      color: theme.text,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xs,
      paddingBottom: spacing.xxxl,
      gap: spacing.lg,
    },
    hero: {
      alignItems: 'center',
      paddingTop: spacing.xs,
      paddingBottom: spacing.sm,
    },
    glyphTile: {
      // Design HTML: 64pt white tile, radius 22, hairline border,
      // soft mauve-tinted shadow, glyph ~44 inside.
      width: 64,
      height: 64,
      borderRadius: 22,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
      marginBottom: spacing.sm + 2,
    },
    glyph: {
      width: 44,
      height: 44,
    },
    appName: {
      // Design HTML: text-2xl (24) extrabold tracking-tight ink.
      fontFamily: fontFamilies.wordmark,
      fontSize: 24,
      letterSpacing: -0.5,
      color: theme.text,
    },
    versionLine: {
      // Design HTML: 12px semibold mauve, tight under the name.
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      letterSpacing: 0.3,
      color: theme.secondary,
      marginTop: 2,
    },
    description: {
      // Design HTML: 13px relaxed muted, max ~310 wide, centred.
      fontFamily: fontFamilies.body,
      fontSize: 13,
      lineHeight: 20,
      color: theme.muted,
      textAlign: 'center',
      maxWidth: 320,
      marginTop: spacing.sm,
    },
    card: {
      // Design HTML: card white, radius 24, padding 16, hairline
      // border + soft shadow (shadow pattern per player.tsx /
      // network precedent — borders alone read flat on Android).
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.lg,
      shadowColor: theme.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.05,
      shadowRadius: 10,
      elevation: 1,
    },
    cardLabel: {
      fontFamily: fontFamilies.heading,
      fontSize: 14,
      color: theme.text,
      marginBottom: spacing.md,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    cardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    cardTitle: {
      // Design HTML: card titles at text-sm (14) bold.
      fontFamily: fontFamilies.display,
      fontSize: 14,
      color: theme.text,
    },
    versionPill: {
      // Design HTML: mauveLight pill, 11px semibold mauve text.
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 2,
    },
    versionPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.secondary,
    },
    headerDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginTop: spacing.sm + 2,
    },
    caption: {
      fontFamily: fontFamilies.body,
      fontSize: 14,
      lineHeight: 20,
      color: theme.muted,
    },
    failedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    retryHit: {
      minHeight: 44,
      justifyContent: 'center',
    },
    retryLabel: {
      fontFamily: fontFamilies.body,
      fontSize: 14,
      color: theme.secondary,
    },
    checkList: {
      gap: spacing.sm + 2,
      marginTop: spacing.md,
    },
    checkRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm + 2,
    },
    checkIcon: {
      marginTop: 1,
    },
    checkLine: {
      // Design HTML: 12px medium ink, relaxed leading.
      flex: 1,
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      lineHeight: 18,
      color: theme.text,
    },
    creditRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    creditDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    creditLabel: {
      // Design HTML: 12px medium muted.
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.muted,
    },
    creditValue: {
      // Design HTML: 12px semibold ink, right-aligned.
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.text,
      flexShrink: 1,
      textAlign: 'right',
    },
    developerLine: {
      // Design HTML: centred footer, 11.5px, muted lead-in.
      fontFamily: fontFamilies.body,
      fontSize: 12,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.sm + 2,
    },
    developerName: {
      // Design HTML: the name in mauveDeep bold.
      fontFamily: fontFamilies.display,
      fontSize: 12,
      color: theme.accent,
    },
    linksCard: {
      // Design HTML: the links card is tighter — padding 8,
      // rows carry their own padding.
      padding: spacing.sm,
    },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      padding: spacing.sm + 2,
      borderRadius: radii.md + 2,
    },
    linkMain: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 2,
      flexShrink: 1,
    },
    linkDisc: {
      // Design HTML: 32pt lavender disc, mauveDeep glyph at 18.
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    linkLabel: {
      // Design HTML: 12px bold ink label + muted url inline.
      fontFamily: fontFamilies.display,
      fontSize: 12,
      color: theme.text,
      flexShrink: 1,
    },
    linkUrl: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.muted,
    },
    linkDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginHorizontal: spacing.md,
    },
    pressed: {
      opacity: 0.7,
    },
  });
