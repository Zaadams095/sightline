import * as Crypto from 'expo-crypto';
import type * as Notifications from 'expo-notifications';

import { isSealedData, mergeOpenedData, openSealedPush } from '@/alerts/sealed';
import { nativeAead } from '@/backup/crypto-native';
import { secrets } from '@/state/secrets';

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
