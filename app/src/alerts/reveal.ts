import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { isSealedData, mergeOpenedData, openSealedPush } from '@/alerts/sealed';
import { nativeAead } from '@/backup/crypto-native';
import { secrets } from '@/state/secrets';
import { AppGroup } from '@modules/app-group';

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>));

/**
 * A notification's content with an end-to-end sealed Instant Alert opened (alerts/sealed.ts).
 * On iOS the notification extension has normally done this already; this covers Android and
 * the rare case it couldn't. Unchanged when there's nothing sealed or it can't be opened.
 */
export async function revealContent(content: Notifications.NotificationContent): Promise<Notifications.NotificationContent> {
  const data = content.data as Record<string, unknown> | undefined;
  if (!isSealedData(data)) return content;
  const secret = await secrets.get('bridge', 'secret').catch(() => null);
  if (!secret) return content;
  const opened = await openSealedPush(data.enc, secret, nativeAead, sha256);
  if (!opened) return content;
  return { ...content, title: opened.title, body: opened.body, data: mergeOpenedData(data, opened) };
}

export async function revealNotification(n: Notifications.Notification): Promise<Notifications.Notification> {
  const content = await revealContent(n.request.content);
  return content === n.request.content ? n : { ...n, request: { ...n.request, content } };
}

export async function revealResponse(resp: Notifications.NotificationResponse): Promise<Notifications.NotificationResponse> {
  const notification = await revealNotification(resp.notification);
  return notification === resp.notification ? resp : { ...resp, notification };
}

/**
 * Whether this build's native side opens sealed alerts before they're shown, so the app may
 * ask the Hub for them (`caps`). JS arrives by over-the-air update on older binaries too, and
 * there the notification would stay "Activity on your cameras" until tapped. iOS: the
 * notification extension learned it in the same build as AppGroup.excludeFromBackup. Android:
 * app/modules/android-notify has always opened data.enc.
 */
export function canOpenSealedAlerts(): boolean {
  if (Platform.OS === 'android') return !!requireOptionalNativeModule('SightlineNotify');
  return typeof AppGroup?.excludeFromBackup === 'function';
}