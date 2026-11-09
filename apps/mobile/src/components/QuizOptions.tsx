import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronRight, X } from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Quiz answer options (Slice M4) — one tappable row per option with
 * a letter chip, shared by the solo game and multiplayer rounds.
 *
 * States:
 * - answering: plain rows; `selected` (multiplayer's locked-in pick)
 *   gets the accent border; `disabled` freezes the list.
 * - reveal (pass `correctValue`): the correct option fills accent
 *   with a check; the player's wrong pick (`pickedValue`) outlines
 *   in secondary with an ×; everything else dims.
 */
export function QuizOptions({
  options,
  onSelect,
  disabled = false,
  selected = null,
  correctValue = null,
  pickedValue = null,
  variant = 'standard',
}: {
  options: string[];
  onSelect: (option: string) => void;
  disabled?: boolean;
  selected?: string | null;
  correctValue?: string | null;
  pickedValue?: string | null;
  /** 'large' = the Quiz Question v2 anatomy (solo question screen):
   *  taller card-radius rows, a tinted letter disc, a chevron.
   *  'room' = the Quiz Room in-game anatomy: 16pt-radius rows, a
   *  32pt letter disc, and — for the locked-in pick — a filled
   *  check disc at the right in place of the chevron. */
  variant?: 'standard' | 'large' | 'room';
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const revealed = correctValue !== null;
  const large = variant === 'large';
  const room = variant === 'room';

  return (
    <View style={[styles.list, room && styles.listRoom]}>
      {options.map((option, i) => {
        const isCorrect = revealed && option === correctValue;
        const isWrongPick =
          revealed && pickedValue !== null && option === pickedValue && !isCorrect;
        const isPicked = revealed ? option === pickedValue : option === selected;
        const dim = revealed && !isCorrect && !isWrongPick;
        return (
          <Pressable
            key={`${i}-${option}`}
            onPress={() => onSelect(option)}
            disabled={disabled || revealed}
            accessibilityRole="button"
            accessibilityLabel={`Option ${LETTERS[i] ?? i + 1}: ${option}`}
            accessibilityState={{ disabled: disabled || revealed, selected: isPicked }}
            style={({ pressed }) => [
              styles.row,
              large && styles.rowLarge,
              room && styles.rowRoom,
              isPicked && !revealed && styles.rowSelected,
              room && isPicked && !revealed && styles.rowRoomSelected,
              isCorrect && styles.rowCorrect,
              isWrongPick && styles.rowWrong,
              dim && styles.rowDim,
              pressed && !disabled && !revealed && styles.pressed,
            ]}
          >
            <View
              style={[
                styles.letter,
                large && styles.letterLarge,
                room && styles.letterRoom,
                isPicked && !isCorrect && styles.letterActive,
                isCorrect && styles.letterCorrect,
                isWrongPick && styles.letterWrong,
              ]}
            >
              {isCorrect ? (
                <Check size={14} color={theme.onAccent} strokeWidth={2.5} />
              ) : isWrongPick ? (
                <X size={14} color={theme.danger} strokeWidth={2.5} />
              ) : (
                <Text
                  style={[
                    styles.letterText,
                    large && styles.letterTextLarge,
                    room && styles.letterTextRoom,
                    isPicked && styles.letterTextActive,
                  ]}
                >
                  {LETTERS[i] ?? `${i + 1}`}
                </Text>
              )}
            </View>
            <Text style={[styles.label, large && styles.labelLarge, room && styles.labelRoom, room && isPicked && styles.labelRoomPicked, isCorrect && styles.labelCorrect]} numberOfLines={2}>
              {option}
            </Text>
            {large && !revealed && (
              <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
            )}
            {room && !revealed && isPicked && (
              <View style={styles.checkDisc}>
                <Check size={16} color={theme.onAccent} strokeWidth={2.5} />
              </View>
            )}
            {room && !revealed && !isPicked && (
              <ChevronRight
                size={18}
                color={withOpacity(theme.secondary, 0.4)}
                strokeWidth={2}
              />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    list: {
      gap: spacing.sm,
    },
    listRoom: {
      gap: 10,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 50,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    rowSelected: {
      borderColor: theme.accent,
      backgroundColor: withOpacity(theme.accent, 0.12),
    },
    rowLarge: {
      minHeight: 62,
      borderRadius: radii.card,
      paddingHorizontal: spacing.lg,
      gap: spacing.md,
    },
    rowRoom: {
      minHeight: 56,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      gap: spacing.md,
    },
    rowRoomSelected: {
      // The HTML's border-2 on the picked card (the base row is 1)
      // and its pale tint fill (the accentContainer token stands
      // in for the HTML's tint, overriding rowSelected's wash).
      borderWidth: 2,
      backgroundColor: theme.accentContainer,
    },
    letterRoom: {
      width: 32,
      height: 32,
      borderRadius: 16,
    },
    letterTextRoom: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.accent,
    },
    labelRoom: {
      fontFamily: fontFamilies.caption,
      fontSize: 17,
    },
    labelRoomPicked: {
      fontFamily: fontFamilies.bodyStrong,
    },
    checkDisc: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowCorrect: {
      // Lavender Dusk Answered state: sage tint + sage border, dark label.
      borderColor: theme.success,
      backgroundColor: theme.successContainer,
    },
    rowWrong: {
      borderColor: theme.danger,
      backgroundColor: theme.dangerContainer,
    },
    rowDim: {
      opacity: 0.55,
    },
    pressed: {
      opacity: 0.85,
    },
    letter: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    letterActive: {
      backgroundColor: theme.accent,
    },
    letterCorrect: {
      backgroundColor: theme.success,
    },
    letterWrong: {
      backgroundColor: withOpacity(theme.danger, 0.18),
    },
    letterText: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    letterLarge: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.accentContainer,
    },
    letterTextLarge: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.accent,
    },
    labelLarge: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
    },
    letterTextActive: {
      color: theme.onAccent,
    },
    label: {
      ...typeStyles.body,
      color: theme.text,
      flex: 1,
    },
    labelCorrect: {
      color: theme.text,
    },
  });
