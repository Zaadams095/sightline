import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const subscribe = (cb: () => void) => {
  const sub = AppState.addEventListener('change', cb);
  return () => sub.remove();
};
const isActive = () => AppState.currentState === 'active';

/** True while the app is on screen (not in the background or the app switcher). */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, isActive);
}
