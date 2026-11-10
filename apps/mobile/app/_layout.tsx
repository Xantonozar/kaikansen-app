// react-native-gesture-handler must be imported before anything
// else in the entry chain — the drawer navigator's gestures depend
// on it being initialised first.
import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  Outfit_600SemiBold,
  Outfit_700Bold,
  Outfit_800ExtraBold,
  Outfit_900Black,
} from '@expo-google-fonts/outfit';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { ThemeProvider, useTheme, useThemeMode } from '../src/theme-context';
import { AuthProvider } from '../src/auth';
import { PlaybackProvider } from '../src/playback-context';
import { ConnectivityProvider } from '../src/connectivity';

/**
 * Root layout. Loads the DESIGN.md font families (Outfit / Inter /
 * JetBrains Mono); if loading fails the app still renders on system fonts.
 * The native splash stays up until fonts settle (no preventAutoHide call).
 *
 * Providers (Slice 2): ThemeProvider owns the dark/light mode (Gate 4:
 * dark by default, persisted choice), AuthProvider owns the session.
 * PlaybackProvider (layout-fidelity Slice 1) owns the ONE shared
 * playback session + engine, so playback survives navigation and the
 * mini player can float over tab and pushed screens. The Shell below
 * consumes the theme so the navigator chrome and the status bar
 * re-skin with the mode.
 *
 * ConnectivityProvider (offline screen, 2026-11-11) sits inside the
 * playback provider and owns the NetInfo subscription + the
 * servability claims the OfflineGate in the drawer shell folds; it
 * mounts at the root so the signed-in cold start (auth restore
 * stuck behind a dead network) is covered too. Session restore is
 * not gated on connectivity — the auth provider's own flow is
 * untouched.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Outfit_600SemiBold,
    Outfit_700Bold,
    Outfit_800ExtraBold,
    Outfit_900Black,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_500Medium,
  });

  useEffect(() => {
    if (fontError) {
      console.warn('Font loading failed; falling back to system fonts.', fontError);
    }
  }, [fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <PlaybackProvider>
          <ConnectivityProvider>
            <Shell />
          </ConnectivityProvider>
        </PlaybackProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function Shell() {
  const theme = useTheme();
  const { mode } = useThemeMode();

  return (
    <GestureHandlerRootView
      style={[styles.root, { backgroundColor: theme.background }]}
    >
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="(drawer)" />
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="anilist-handoff" />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
