import { Redirect, useLocalSearchParams } from 'expo-router';

/** Deep link sightline://hub?url=…&code=… (the QR on a Hub's setup page) → pairing screen. */
export default function HubLink() {
  const params = useLocalSearchParams<{ url?: string; code?: string; lan?: string; remote?: string; name?: string }>();
  return <Redirect href={{ pathname: '/onboarding/invite', params: { ...params, kind: 'pair' } }} />;
}
