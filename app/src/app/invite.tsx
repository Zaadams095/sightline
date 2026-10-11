import { Redirect, useLocalSearchParams } from 'expo-router';

/** Deep link sightline://invite?url=…&code=… (a shared-access invite) → the join screen. */
export default function InviteLink() {
  const params = useLocalSearchParams<{ url?: string; code?: string; lan?: string; remote?: string; name?: string }>();
  return <Redirect href={{ pathname: '/onboarding/invite', params: { ...params, kind: 'invite' } }} />;
}
