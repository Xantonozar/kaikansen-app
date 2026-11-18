import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Drawer } from 'expo-router/drawer';
import { AppDrawerContent } from '../../src/components/AppDrawerContent';
import { MiniPlayer } from '../../src/components/MiniPlayer';
import { OfflineGate } from '../../src/components/OfflineGate';
import { UpdatePromptGate } from '../../src/components/UpdatePromptGate';
import { useTheme } from '../../src/theme-context';

/**
 * Drawer shell (the sidebar) — the parent navigator inside the root
 * stack. It wraps the tab shell plus the screens reached from inside
 * the app (Search, Settings, theme detail), so the drawer stays
 * reachable from all of them. The custom content component renders
 * every entry itself, so the default drawer item list is unused;
 * screens are declared hidden and exist only as navigation targets.
 * Log in / Register stay on the root stack (pre-auth surfaces).
 *
 * The mini player (layout-fidelity Slice 1) overlays the bottom of
 * pushed screens from here; it gates itself off tab routes (the
 * TabBar mount covers those), the player route and quiz play.
 *
 * The offline gate (offline screen, 2026-11-11) overlays everything
 * from here when the device is definitively offline and the
 * current surface cannot serve — see src/components/OfflineGate.
 * It lives in this shell (not the root stack) so the pre-auth
 * surfaces stay structurally outside it.
 */
export default function DrawerLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.84, 288);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
    <Drawer
      drawerContent={(props) => <AppDrawerContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerStyle: { backgroundColor: theme.background, width: drawerWidth },
        sceneStyle: { backgroundColor: theme.background },
      }}
    >
      <Drawer.Screen name="(tabs)" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="search" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="settings" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen
        name="theme/[slug]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen name="player" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/solo" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/leaderboard" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/ladder" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/lobby" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/create" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/room" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen
        name="anime/[id]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="artist/[slug]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen name="season" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen
        name="playlist/[id]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="user/[username]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="notifications"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen name="chat/index" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="chat/new" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="chat/requests" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="chat/archived" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="chat/blocked" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="chat/[id]" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen
        name="downloads"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="about"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="edit-profile"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="favourites"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="network/[username]"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="profile"
        options={{ drawerItemStyle: { display: 'none' } }}
      />
    </Drawer>
    <MiniPlayer placement="overlay" />
    <UpdatePromptGate />
    <OfflineGate />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
