import { Users } from 'lucide-react-native';
import { PlaceholderScreen } from '../../../src/components/PlaceholderScreen';

export default function SocialScreen() {
  return (
    <PlaceholderScreen
      title="Social"
      note="Friends activity, profiles and the network arrive in a later slice — this tab is a shell placeholder for now."
      Icon={Users}
    />
  );
}
