import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { darkTheme, lightTheme, type Theme } from './theme';

/**
 * Stateful theme (Slice 2). Slice 0 shipped the two token sets as data
 * with dark hard-wired; this provider makes the mode a real, persisted
 * choice: Gate 4 — dark by default, light a full peer selectable in
 * Settings. The choice persists in plain AsyncStorage (it is a display
 * preference, not a secret).
 */

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'kaikansen.themeMode';

interface ThemeContextValue {
  tokens: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  tokens: darkTheme,
  mode: 'dark',
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark') setModeState(saved);
      })
      .catch(() => {});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      tokens: mode === 'dark' ? darkTheme : lightTheme,
      mode,
      setMode: (next: ThemeMode) => {
        setModeState(next);
        AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      },
    }),
    [mode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** The active token set. All component styling flows through this. */
export function useTheme(): Theme {
  return useContext(ThemeContext).tokens;
}

/** The mode + switch, for the Settings theme toggle. */
export function useThemeMode(): { mode: ThemeMode; setMode: (m: ThemeMode) => void } {
  const { mode, setMode } = useContext(ThemeContext);
  return { mode, setMode };
}
