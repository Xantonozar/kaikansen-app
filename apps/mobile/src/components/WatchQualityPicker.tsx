import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import type { VideoSource } from '@kaikansen/contracts';
import {
  playingResolution,
  watchQualityOptions,
  watchQualityPickerVisible,
} from '../mediaEngine';
import {
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';

/**
 * Watch quality picker (perf problem 7) — ONE shared component for
 * the Player page and Theme Detail's inline watch. It lists exactly
 * the entry's offered video sources (real resolution values,
 * best first), marks the source that is ACTUALLY playing
 * (`activeUrl` — matched by URL against the engine's live source,
 * never a pending pick), and fires `onPick` with the chosen URL;
 * the engine owns the switch (position + playing state preserved,
 * failures walk the existing chain).
 *
 * No picker for single-source entries (owner's call): the
 * component renders nothing unless `watchQualityPickerVisible`
 * says there is a real choice. The trigger matches the Player
 * screen's resolution chip pixel for pixel (translucent white
 * pill, green dot, caption 10px). On Theme Detail the picker
 * sits in the control strip (its dark scrim row), where it
 * doubles as that screen's resolution chip — the detail hero
 * had none before this job.
 *
 * The sheet is a bottom sheet in the AddToPlaylistSheet pattern
 * (transparent Modal, fade, surface card with card radii on the
 * top corners).
 */
export function WatchQualityPicker({
  sources,
  activeUrl,
  onPick,
}: {
  /** The entry's offered video sources (raw, unsorted). */
  sources: readonly VideoSource[] | null | undefined;
  /** The URL the engine is actually playing right now. */
  activeUrl: string | null;
  /** Choose a source by URL — the engine switches to it. */
  onPick: (url: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [open, setOpen] = useState(false);

  const options = watchQualityOptions(sources ?? []);
  const current = playingResolution(sources ?? [], activeUrl);
  if (!watchQualityPickerVisible(sources ?? [])) return null;

  const choose = (url: string) => {
    setOpen(false);
    onPick(url);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          current !== null
            ? `Video quality, currently ${current}p`
            : 'Video quality'
        }
        style={({ pressed }) => [
          styles.chip,
          pressed && styles.chipPressed,
        ]}
      >
        <View style={styles.chipDot} />
        <Text style={styles.chipText}>
          {current !== null ? `${current}p` : 'Quality'}
        </Text>
        <ChevronDown size={12} color="#FFFFFF" strokeWidth={2} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.backdrop}>
          <Pressable
            style={styles.dismiss}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close quality picker"
          />
          <View style={styles.sheet}>
            <Text style={styles.title}>Quality</Text>
            {options.map((option) => {
              const isPlaying = option.url === activeUrl;
              return (
                <Pressable
                  key={option.url}
                  onPress={() => choose(option.url)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isPlaying
                      ? `${option.resolution}p, currently playing`
                      : `${option.resolution}p`
                  }
                  accessibilityState={{ selected: isPlaying }}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.rowText,
                      isPlaying && styles.rowTextActive,
                    ]}
                  >
                    {option.resolution}p
                  </Text>
                  <View style={styles.rowSpacer} />
                  {isPlaying ? (
                    <Check
                      size={18}
                      color={theme.accent}
                      strokeWidth={2.4}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>
    </>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    chip: {
      // Identical treatment to the Player's resChip style.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: 'rgba(255, 255, 255, 0.2)',
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    chipPressed: {
      opacity: 0.75,
    },
    chipDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    chipText: {
      fontFamily: typeStyles.caption.fontFamily,
      fontSize: 10,
      color: 'rgba(255, 255, 255, 0.9)',
    },
    backdrop: {
      flex: 1,
      backgroundColor: withOpacity(theme.background, 0.72),
      justifyContent: 'flex-end',
    },
    dismiss: {
      flex: 1,
    },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: radii.cardLg,
      borderTopRightRadius: radii.cardLg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xl,
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      marginBottom: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    rowPressed: {
      opacity: 0.7,
    },
    rowText: {
      ...typeStyles.body,
      color: theme.text,
    },
    rowTextActive: {
      fontFamily: typeStyles.body.fontFamily,
      color: theme.accent,
    },
    rowSpacer: {
      flex: 1,
    },
  });
