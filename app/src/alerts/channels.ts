import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { subscribeLocale, tr } from '@/i18n';

/**
 * Android notification channels: the groups people see (and can quiet one by one) under
 * Settings › Apps › Sightline › Notifications. The Hub picks the same IDs for its pushes
 * (bridge/push.go), so keep the two in sync. iOS has no channels; everything here is a no-op.
 */
export type AlertChannel = 'alerts' | 'doorbell' | 'packages' | 'checkins' | 'health';

const ANDROID = Platform.OS === 'android';

/**
 * "Show it now" for scheduleNotificationAsync: on Android through `channel`, so it gets that
 * channel's sound and importance; on iOS the usual immediate trigger.
 */
export function showNow(channel: AlertChannel): Notifications.NotificationTriggerInput {
  return ANDROID ? { channelId: channel } : null;
}

/** `{ channelId }` to spread into a scheduled trigger on Android; nothing on iOS. */
export function channelOf(channel: AlertChannel): { channelId?: string } {
  return ANDROID ? { channelId: channel } : {};
}

/**
 * Notification data that shows a downloaded snapshot on Android (iOS uses `attachments`,
 * which Android ignores). Read by app/modules/android-notify's presenter.
 */
export function androidImage(fileUri: string | undefined): { androidImage?: string } {
  return ANDROID && fileUri ? { androidImage: fileUri } : {};
}

async function createChannels() {
  const names = tr().alerts.channels;
  const { AndroidImportance: I, AndroidNotificationVisibility: V } = Notifications;
  const channels: [AlertChannel, Notifications.NotificationChannelInput][] = [
    // Heads-up banners with sound. Lock screen shows that something happened, not the picture.
    ['alerts', { name: names.alerts, description: names.alertsAbout, importance: I.HIGH, lockscreenVisibility: V.PRIVATE }],
    // A ring is someone waiting at the door: the most urgent heads-up Android allows, longer
    // vibration. (No full-screen intent: Google Play keeps USE_FULL_SCREEN_INTENT for calling
    // and alarm apps, so the ring opens the call screen when it's tapped instead.)
    [
      'doorbell',
      {
        name: names.doorbell,
        description: names.doorbellAbout,
        importance: I.MAX,
        vibrationPattern: [0, 400, 250, 400, 250, 400],
        lockscreenVisibility: V.PUBLIC,
      },
    ],
    ['packages', { name: names.packages, description: names.packagesAbout, importance: I.HIGH, lockscreenVisibility: V.PRIVATE }],
    ['checkins', { name: names.checkins, description: names.checkinsAbout, importance: I.HIGH, lockscreenVisibility: V.PRIVATE }],
    // Camera offline, storage full: worth knowing, not worth a banner.
    ['health', { name: names.health, description: names.healthAbout, importance: I.DEFAULT }],
  ];
  for (const [id, channel] of channels) {
    // Updating an existing channel only changes its name and description: Android keeps the
    // person's own choices (sound, importance) once a channel exists.
    await Notifications.setNotificationChannelAsync(id, channel).catch(() => null);
  }
}

let ready: Promise<void> | null = null;

/**
 * Creates the channels (call before asking for notification permission and before getting a
 * push token: Android 13+ only shows the permission prompt once a channel exists) and renames
 * them when the app's language changes.
 */
export function setupChannels(): Promise<void> {
  if (!ANDROID) return Promise.resolve();
  if (!ready) {
    ready = createChannels();
    subscribeLocale(() => void createChannels());
  }
  return ready;
}
