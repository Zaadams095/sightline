import { fromBase64, utf8Decode, utf8Encode, type Aead } from '../backup/bundle.ts';

/**
 * End-to-end sealed Instant Alerts (bridge/seal.go). Phones that send `caps: [ENC_MSG_CAP]`
 * get pushes whose visible text is generic ("Activity on your cameras"); the real title, body,
 * thread and data travel in `data.enc`: base64(nonce || AES-256-GCM ciphertext || tag) of one
 * flat JSON object of strings {"v":"1","title","body","threadId", ...data fields}, key =
 * SHA-256("sightline-msg-v1:" + secret), the same secret the thumbnail uses (`bridge.secret`).
 * On iOS the notification extension opens it before the notification is shown, on Android
 * app/modules/android-notify does; this is the app's fallback for a notification that still
 * arrives sealed, used before reading its data. Pure (crypto passed in).
 */
export const ENC_MSG_CAP = 'enc-msg-v1';
const KEY_CONTEXT = 'sightline-msg-v1:';
const META = new Set(['v', 'title', 'body', 'threadId']);

export type Sha256 = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface OpenedPush {
  title: string;
  body: string;
  threadId?: string;
  data: Record<string, string>;
}

/** True when the data still carries an unopened sealed part. */
export function isSealedData(data: unknown): data is { enc: string } {
  return !!data && typeof (data as { enc?: unknown }).enc === 'string';
}

/** The sealed part, or null when it can't be opened (wrong secret, changed, unknown version). */
export async function openSealedPush(enc: string, secret: string, aead: Aead, sha256: Sha256): Promise<OpenedPush | null> {
  try {
    const key = await sha256(utf8Encode(KEY_CONTEXT + secret));
    const plain = await aead.open(key, fromBase64(enc), new Uint8Array(0));
    const o = JSON.parse(utf8Decode(plain)) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o.v !== '1' || typeof o.title !== 'string') return null;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (!META.has(k) && typeof v === 'string') data[k] = v;
    return {
      title: o.title,
      body: typeof o.body === 'string' ? o.body : '',
      threadId: typeof o.threadId === 'string' && o.threadId ? o.threadId : undefined,
      data,
    };
  } catch {
    return null;
  }
}

/** Notification data as the Hub meant it: the visible fields plus the opened ones, no `enc`. */
export function mergeOpenedData(visible: Record<string, unknown>, opened: OpenedPush): Record<string, unknown> {
  const { enc: _enc, ...rest } = visible;
  return { ...rest, ...opened.data };
}
