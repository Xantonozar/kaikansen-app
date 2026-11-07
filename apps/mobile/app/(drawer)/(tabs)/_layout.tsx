import { Tabs } from 'expo-router';
import { AppHeader } from '../../../src/components/AppHeader';
import { TabBar } from '../../../src/components/TabBar';
import { useTheme } from '../../../src/theme-context';

/**
 * Tab shell (DESIGN.md §5): the translucent app header on every tab screen
 * and the custom four-tab bottom navigation with the accent-pill active tab.
 */
export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        header: () => <AppHeader />,
        sceneStyle: { backgroundColor: theme.background },
      }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="quiz" options={{ title: 'Quiz' }} />
      <Tabs.Screen name="social" options={{ title: 'Social' }} />
      <Tabs.Screen name="library" options={{ title: 'Library' }} />
    </Tabs>
  );
}
