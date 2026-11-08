import { useWindowDimensions } from 'react-native';
import { Drawer } from 'expo-router/drawer';
import { AppDrawerContent } from '../../src/components/AppDrawerContent';
import { useTheme } from '../../src/theme-context';

/**
 * Drawer shell (the sidebar) — the parent navigator inside the root
 * stack. It wraps the tab shell plus the screens reached from inside
 * the app (Search, Settings, theme detail), so the drawer stays
 * reachable from all of them. The custom content component renders
 * every entry itself, so the default drawer item list is unused;
 * screens are declared hidden and exist only as navigation targets.
 * Log in / Register stay on the root stack (pre-auth surfaces).
 */
export default function DrawerLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.84, 288);

  return (
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
      <Drawer.Screen name="quiz/lobby" options={{ drawerItemStyle: { display: 'none' } }} />
      <Drawer.Screen name="quiz/room" options={{ drawerItemStyle: { display: 'none' } }} />
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
    </Drawer>
  );
}
