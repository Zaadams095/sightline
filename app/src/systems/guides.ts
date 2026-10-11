import type { SystemKind } from '@/systems/types';

/**
 * Guided setup for the everyday cameras most people own. Each brand is plain data: a few short
 * steps to do in the brand's own app, then where Sightline takes over (a stream link it builds
 * for you, one of the recorder adapters, or a kind "this one can't work, here's what can").
 * Adding a brand means adding an entry here; the screens never special-case a brand.
 *
 * Sources and caveats for every entry live in docs/CAMERA_GUIDES.md. Keep that in sync.
 * This file must stay free of React Native imports: it is unit-tested with plain Node.
 */

/** Ports to look for on the home network to spot this kind of camera. */
export interface ScanSpec {
  ports: number[];
  /** True: every port must answer (sharper match). False: any one will do. */
  needAll?: boolean;
}

/** Sightline builds an rtsp:// link from the address and the camera account the user just made. */
export interface StreamTarget {
  type: 'stream';
  /** Tokens: {auth} (user:pass@ or nothing), {host}, {port}, {channel}. */
  template: string;
  port: number;
  /** Prefilled (and usually right) username, e.g. 'admin' for cameras that use the sticker code. */
  username?: string;
  usernameLabel?: string;
  usernameHint?: string;
  passwordLabel?: string;
  passwordHint?: string;
  /** The brand's app shows a ready-made link: offer "Paste the link" as the easy path. */
  pasteLink?: boolean;
  scan: ScanSpec;
  /** Default camera name. */
  cameraName: string;
}

/** Hand over to an existing adapter's setup screen, with the right brand preselected. */
export interface SystemTarget {
  type: 'system';
  system: SystemKind;
  /** Name to start with on the setup screen (e.g. "Amcrest" rather than "Dahua / Amcrest / Lorex"). */
  name: string;
  username?: string;
}

export type Alternative =
  | { label: string; action: 'brands' | 'discover' | 'stream' }
  | { label: string; action: 'guide'; guide: string; option?: string };

/** Honest dead end for the camera, never for the person: explain kindly, then offer a way on. */
export interface UnsupportedTarget {
  type: 'unsupported';
  why: string;
  alternatives: Alternative[];
}

export type GuideTarget = StreamTarget | SystemTarget | UnsupportedTarget;

export interface GuideOption {
  id: string;
  /** Shown when a brand has more than one kind of camera ("Which one do you have?"). */
  title: string;
  detail?: string;
  /** Short steps done in the brand's app. The last "come back here" step is added for you. */
  steps: string[];
  target: GuideTarget;
}

export type GuideGroup = 'camera' | 'recorder' | 'cloud';

export interface BrandGuide {
  id: string;
  name: string;
  group: GuideGroup;
  /** Search words: other names, the app's name, model names. */
  keywords: string[];
  /** The phone app people use with this brand (helps "I don't know my brand"). */
  app?: string;
  options: GuideOption[];
}

/** Last step for every guide that continues in Sightline. */
export const COME_BACK_STEP = 'Come back here and tap Next.';

const PICK_ANOTHER: Alternative = { label: 'Pick a different brand', action: 'brands' };
const FIND: Alternative = { label: 'Find cameras on my Wi-Fi', action: 'discover' };
const LINK: Alternative = { label: 'I have a stream link (rtsp://…)', action: 'stream' };

const CLOUD_ALTERNATIVES: Alternative[] = [
  { label: 'See cameras that work with Sightline', action: 'brands' },
  FIND,
];

const cloud = (id: string, name: string, app: string, keywords: string[], why: string): BrandGuide => ({
  id,
  name,
  group: 'cloud',
  keywords,
  app,
  options: [{ id: 'all', title: name, steps: [], target: { type: 'unsupported', why, alternatives: CLOUD_ALTERNATIVES } }],
});

export const GUIDES: BrandGuide[] = [
  {
    id: 'tapo',
    name: 'TP-Link Tapo',
    group: 'camera',
    keywords: ['tapo', 'tp-link', 'tplink', 'tp link', 'c100', 'c110', 'c120', 'c200', 'c210', 'c220', 'c225', 'c310', 'c320', 'c500', 'c510', 'c520'],
    app: 'Tapo',
    options: [
      {
        id: 'plugin',
        title: 'Plugged-in camera',
        detail: 'Most Tapo cameras with a power cord',
        steps: [
          'Open the Tapo app and tap your camera.',
          'Tap the gear at the top right, then Advanced Settings → Camera Account.',
          'Tap “Understand and Agree to Use”. Make a username and a password (6 to 32 characters each) and write them down. This is just for the camera, not your Tapo login.',
        ],
        target: {
          type: 'stream',
          template: 'rtsp://{auth}{host}:{port}/stream1',
          port: 554,
          usernameLabel: 'Camera account username',
          usernameHint: 'The username you just made in the Tapo app.',
          passwordLabel: 'Camera account password',
          passwordHint: 'Not your Tapo login password.',
          scan: { ports: [554, 2020], needAll: true },
          cameraName: 'Tapo camera',
        },
      },
      {
        id: 'battery',
        title: 'Battery camera or doorbell',
        detail: 'Like the C400, C420, C425 or a battery doorbell',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Tapo battery cameras sleep between recordings to save power, so they only send video to the Tapo app. Sightline can’t show them, but it works with Tapo cameras that plug into the wall.',
          alternatives: [{ label: 'Set up a plugged-in Tapo camera', action: 'guide', guide: 'tapo', option: 'plugin' }, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'wyze',
    name: 'Wyze',
    group: 'camera',
    keywords: ['wyze', 'cam v3', 'pan v3', 'v3', 'v4', 'og', 'wyze bridge'],
    app: 'Wyze',
    options: [
      {
        id: 'v3',
        title: 'Wyze Cam v3 or Pan v3',
        detail: 'With the camera’s latest update',
        steps: [
          'Update the Wyze app, then update the camera (camera settings → Device Info → Firmware).',
          'In the camera’s settings, tap Advanced Settings → RTSP and turn it on.',
          'Make a username and password (4 to 10 letters or numbers), then tap Generate URL.',
          'Tap Copy to copy the link it shows.',
        ],
        target: {
          type: 'stream',
          template: 'rtsp://{auth}{host}:{port}/stream0',
          port: 554,
          pasteLink: true,
          usernameLabel: 'RTSP username',
          usernameHint: 'The username you just made in the Wyze app.',
          passwordLabel: 'RTSP password',
          scan: { ports: [554] },
          cameraName: 'Wyze camera',
        },
      },
      {
        id: 'other',
        title: 'Wyze Cam v4, OG, doorbell or battery camera',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'These Wyze cameras only send video to the Wyze app for now. Wyze has said a stream option is coming for the Cam v4, but it isn’t out yet. If it arrives, come back and pick “Wyze Cam v3 or Pan v3”, the steps are the same.',
          alternatives: [LINK, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'eufy',
    name: 'eufy',
    group: 'camera',
    keywords: ['eufy', 'eufycam', 'anker', 'indoor cam', 'homebase', 'eufy security', 'e220', 's350'],
    app: 'eufy Security',
    options: [
      {
        id: 'rtsp',
        title: 'Camera with “NAS (RTSP)”',
        detail: 'Most plugged-in eufy cameras',
        steps: [
          'Open the eufy Security app and tap your camera, then the gear for its settings.',
          'Look for Storage → NAS (RTSP) and turn it on. If you don’t see it, this camera can’t share video (see “Other eufy cameras”).',
          'Choose “Continuous” so video is always there, set a username and password, and copy the link it shows.',
        ],
        target: {
          type: 'stream',
          template: 'rtsp://{auth}{host}:{port}/live0',
          port: 554,
          pasteLink: true,
          usernameLabel: 'RTSP username',
          usernameHint: 'The username from the NAS (RTSP) screen in the eufy app.',
          passwordLabel: 'RTSP password',
          scan: { ports: [554] },
          cameraName: 'eufy camera',
        },
      },
      {
        id: 'other',
        title: 'Other eufy cameras',
        detail: 'No “NAS (RTSP)” in the app',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Some eufy cameras, mostly battery ones, only send video to the eufy app. If the app has no “NAS (RTSP)” setting for the camera, Sightline can’t show it.',
          alternatives: [{ label: 'Check again for “NAS (RTSP)”', action: 'guide', guide: 'eufy', option: 'rtsp' }, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'imou',
    name: 'Imou',
    group: 'camera',
    keywords: ['imou', 'imou life', 'ranger', 'cruiser', 'bullet', 'cue', 'dahua'],
    app: 'Imou Life',
    options: [
      {
        id: 'camera',
        title: 'Imou camera',
        detail: 'Most plugged-in models',
        steps: [
          'Find the sticker on the camera (often underneath). Look for “Safety code” or “SC”, a short code of letters and numbers.',
          'Take a photo of it, or write it down exactly. Capital letters matter.',
        ],
        target: {
          type: 'stream',
          template: 'rtsp://{auth}{host}:{port}/cam/realmonitor?channel={channel}&subtype=0',
          port: 554,
          username: 'admin',
          usernameHint: 'Imou cameras use “admin”.',
          passwordLabel: 'Safety code',
          passwordHint: 'The code from the sticker, even if you changed the password in the Imou app.',
          scan: { ports: [554] },
          cameraName: 'Imou camera',
        },
      },
    ],
  },
  {
    id: 'ezviz',
    name: 'EZVIZ',
    group: 'camera',
    keywords: ['ezviz', 'hikvision', 'c3', 'c6', 'c8', 'h6', 'h8'],
    app: 'EZVIZ',
    options: [
      {
        id: 'camera',
        title: 'EZVIZ camera',
        detail: 'Many plugged-in models',
        steps: [
          'Find the sticker on the camera and note the 6-letter “Verification code”. Capital letters matter.',
          'In the EZVIZ app, tap your profile → Settings → LAN Live View → Start Scanning, and pick your camera.',
          'Tap the gear → Local Server Settings, and turn on RTSP. If there’s no RTSP switch, this camera can’t share video.',
        ],
        target: {
          type: 'stream',
          template: 'rtsp://{auth}{host}:{port}/h264/ch1/main/av_stream',
          port: 554,
          username: 'admin',
          usernameHint: 'EZVIZ cameras use “admin”.',
          passwordLabel: 'Verification code',
          passwordHint: 'The code from the camera’s sticker.',
          scan: { ports: [554] },
          cameraName: 'EZVIZ camera',
        },
      },
    ],
  },
  {
    id: 'kasa',
    name: 'Kasa',
    group: 'camera',
    keywords: ['kasa', 'kasa smart', 'tp-link', 'kc', 'ec', 'spot'],
    app: 'Kasa Smart',
    options: [
      {
        id: 'all',
        title: 'Kasa camera',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Kasa cameras only send video to the Kasa app, so Sightline can’t show them. TP-Link’s Tapo cameras (same company) do work with Sightline.',
          alternatives: [{ label: 'Set up a Tapo camera', action: 'guide', guide: 'tapo' }, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'reolink',
    name: 'Reolink',
    group: 'recorder',
    keywords: ['reolink', 'argus', 'e1', 'rlc', 'duo', 'home hub', 'altas', 'lumus', 'trackmix'],
    app: 'Reolink',
    options: [
      {
        id: 'wired',
        title: 'Plugged-in camera, recorder or Home Hub',
        detail: 'Anything with a power cord, a recorder box, or a Home Hub',
        steps: [
          'Have your Reolink password ready (the one for the camera or recorder in the Reolink app).',
          'If you have a recorder or Home Hub, use it: every camera on it shows up in Sightline, battery ones too.',
        ],
        target: { type: 'system', system: 'reolink', name: 'Reolink', username: 'admin' },
      },
      {
        id: 'battery',
        title: 'Battery camera on its own',
        detail: 'Argus, Altas, battery doorbell, without a Home Hub',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Reolink battery cameras sleep to save power, so on their own they only talk to the Reolink app. Connected to a Reolink Home Hub or recorder, they work in Sightline.',
          alternatives: [{ label: 'I have a Home Hub or recorder', action: 'guide', guide: 'reolink', option: 'wired' }, PICK_ANOTHER],
        },
      },
      {
        id: 'lte',
        title: '4G / LTE camera (with a SIM card)',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Reolink’s 4G cameras use the mobile network instead of your home Wi-Fi, so only the Reolink app can reach them.',
          alternatives: [PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'amcrest',
    name: 'Amcrest',
    group: 'recorder',
    keywords: ['amcrest', 'amcrest smart home', 'amcrest view', 'ash', 'ip2m', 'ip4m', 'ip5m', 'ip8m', 'dahua'],
    app: 'Amcrest Smart Home or Amcrest View Pro',
    options: [
      {
        id: 'all',
        title: 'Amcrest camera or recorder',
        steps: [
          'Have the camera’s (or recorder’s) admin password ready, the one you made when you first set it up.',
          'If your cameras are on a recorder, use the recorder’s address: all its cameras show up at once.',
        ],
        target: { type: 'system', system: 'dahua', name: 'Amcrest', username: 'admin' },
      },
    ],
  },
  {
    id: 'lorex',
    name: 'Lorex',
    group: 'recorder',
    keywords: ['lorex', 'lorex home', 'lorex cloud', 'fusion', 'nvr', 'dvr'],
    app: 'Lorex Home or Lorex Cloud',
    options: [
      {
        id: 'recorder',
        title: 'Recorder (a box your cameras plug into)',
        detail: 'Most Lorex NVR and DVR kits',
        steps: [
          'On the recorder’s screen, open Main Menu → Network to see its IP address, or check Device info in the Lorex app.',
          'Have the recorder’s admin password ready (the one you use on the recorder’s screen).',
        ],
        target: { type: 'system', system: 'dahua', name: 'Lorex', username: 'admin' },
      },
      {
        id: 'wifi',
        title: 'Wi-Fi or battery camera with no recorder',
        detail: 'Set up only in the Lorex Home app',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Most Lorex Wi-Fi and battery cameras without a recorder only send video to the Lorex app. If yours is connected to a Lorex recorder, add the recorder instead and it will show up.',
          alternatives: [{ label: 'It’s on a Lorex recorder', action: 'guide', guide: 'lorex', option: 'recorder' }, FIND, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'swann',
    name: 'Swann',
    group: 'recorder',
    keywords: ['swann', 'swann security', 'swannview', 'nvr', 'dvr'],
    app: 'Swann Security',
    options: [
      {
        id: 'recorder',
        title: 'Recorder (a box your cameras plug into)',
        detail: 'Most Swann NVR and DVR kits',
        steps: [
          'On the recorder’s screen, open the menu → Network to see its IP address.',
          'Have the recorder’s admin password ready (the one you use on the recorder’s screen).',
        ],
        target: { type: 'system', system: 'onvif', name: 'Swann', username: 'admin' },
      },
      {
        id: 'wifi',
        title: 'Wi-Fi or battery camera with no recorder',
        steps: [],
        target: {
          type: 'unsupported',
          why: 'Swann’s Wi-Fi and battery cameras only send video to the Swann Security app, so Sightline can’t show them.',
          alternatives: [{ label: 'I have a Swann recorder', action: 'guide', guide: 'swann', option: 'recorder' }, PICK_ANOTHER],
        },
      },
    ],
  },
  {
    id: 'annke',
    name: 'Annke',
    group: 'recorder',
    keywords: ['annke', 'annke vision', 'hikvision', 'nvr', 'dvr'],
    app: 'Annke Vision',
    options: [
      {
        id: 'all',
        title: 'Annke camera or recorder',
        steps: [
          'Have the admin password ready, the one you made when you first set up the camera or recorder.',
          'If your cameras are on a recorder, use the recorder: all its cameras show up at once.',
        ],
        target: { type: 'system', system: 'hikvision', name: 'Annke', username: 'admin' },
      },
    ],
  },
  {
    id: 'hikvision',
    name: 'Hikvision',
    group: 'recorder',
    // Hikvision makes cameras and recorders sold under other names too.
    keywords: ['hikvision', 'hik-connect', 'hik connect', 'hiwatch', 'lts', 'lt security', 'nvr', 'dvr'],
    app: 'Hik-Connect',
    options: [
      {
        id: 'all',
        title: 'Hikvision camera or recorder',
        detail: 'Also HiWatch, LTS and other Hikvision-made brands',
        steps: [
          'Have the admin password ready, the one you sign in to the recorder with (not your Hik-Connect account).',
        ],
        target: { type: 'system', system: 'hikvision', name: 'Hikvision', username: 'admin' },
      },
    ],
  },
  {
    id: 'dahua',
    name: 'Dahua',
    group: 'recorder',
    keywords: ['dahua', 'dmss', 'nvr', 'xvr'],
    app: 'DMSS',
    options: [
      {
        id: 'all',
        title: 'Dahua camera or recorder',
        steps: ['Have the admin password ready, the one you use on the recorder’s screen.'],
        target: { type: 'system', system: 'dahua', name: 'Dahua', username: 'admin' },
      },
    ],
  },
  {
    id: 'ubiquiti',
    name: 'Ubiquiti UniFi',
    group: 'recorder',
    keywords: ['ubiquiti', 'unifi', 'protect', 'g4', 'g5', 'dream machine', 'udm', 'cloud key', 'ucg'],
    app: 'UniFi Protect',
    options: [
      {
        id: 'all',
        title: 'UniFi Protect',
        steps: [
          'On a computer, open your UniFi console and go to Admins & Users → add a new admin.',
          'Choose “Restrict to local access only”, give it access to Protect, and set a username and password.',
        ],
        target: { type: 'system', system: 'unifi-protect', name: 'UniFi Protect' },
      },
    ],
  },
  cloud(
    'ring',
    'Ring',
    'Ring',
    ['ring', 'amazon', 'doorbell', 'stick up', 'spotlight'],
    'Ring cameras send video only to Ring’s cloud, and Ring doesn’t let other apps watch them. That’s Ring’s choice, not something wrong with your camera. Keep using the Ring app for these.',
  ),
  cloud(
    'nest',
    'Google Nest',
    'Google Home',
    ['nest', 'google', 'google home', 'dropcam', 'doorbell'],
    'Nest cameras send video only to Google’s cloud. Google doesn’t offer a way for apps like Sightline to show them on your home network. Keep using the Google Home app for these.',
  ),
  cloud(
    'arlo',
    'Arlo',
    'Arlo Secure',
    ['arlo', 'netgear', 'essential', 'pro', 'ultra'],
    'Arlo cameras send video only to Arlo’s cloud, so Sightline can’t show them. Keep using the Arlo app for these.',
  ),
  cloud(
    'blink',
    'Blink',
    'Blink Home Monitor',
    ['blink', 'amazon', 'outdoor', 'mini', 'sync module'],
    'Blink cameras send video only to Blink’s cloud, so Sightline can’t show them. Keep using the Blink app for these.',
  ),
  cloud(
    'simplisafe',
    'SimpliSafe',
    'SimpliSafe',
    ['simplisafe', 'simply safe', 'simplicam'],
    'SimpliSafe cameras are part of SimpliSafe’s own system and don’t share video with other apps. Keep using the SimpliSafe app for these.',
  ),
];

export const GROUP_TITLES: Record<GuideGroup, string> = {
  camera: 'Wi-Fi cameras',
  recorder: 'Cameras with a recorder, and pro brands',
  cloud: 'Cloud-only cameras',
};

export function guideById(id: string | undefined): BrandGuide | undefined {
  return GUIDES.find((g) => g.id === id);
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Brands matching what the user typed (name, other names, app name, model). Empty query: all. */
export function searchGuides(query: string, guides: BrandGuide[] = GUIDES): BrandGuide[] {
  const q = fold(query);
  if (!q) return guides;
  const score = (g: BrandGuide) => {
    const name = fold(g.name);
    if (name.startsWith(q) || name.split(' ').some((w) => w.startsWith(q))) return 0;
    if (g.app && fold(g.app).includes(q)) return 1;
    if (g.keywords.some((k) => fold(k).startsWith(q))) return 2;
    if (name.includes(q) || g.keywords.some((k) => fold(k).includes(q))) return 3;
    return -1;
  };
  return guides
    .map((g) => ({ g, s: score(g) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.g);
}

/** The steps to show, including the "come back" step when Sightline takes over afterwards. */
export function stepsFor(option: GuideOption): string[] {
  if (option.target.type === 'unsupported') return [];
  return [...option.steps, COME_BACK_STEP];
}

export interface Address {
  host: string;
  port?: number;
}

/**
 * Reads what someone typed as a camera address: "192.168.1.5", "192.168.1.5:8554",
 * "http://192.168.1.5/", "camera.local". Returns null when there's no usable host.
 */
export function parseAddress(input: string): Address | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^@/]*@/, '');
  s = s.split(/[/?#]/)[0] ?? '';
  if (!s) return null;
  // [IPv6]:port
  const v6 = s.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i);
  if (v6) return { host: `[${v6[1]}]`, port: v6[2] ? Number(v6[2]) : undefined };
  // Bare IPv6 (several colons): no port.
  if ((s.match(/:/g) ?? []).length > 1) return /^[0-9a-f:.]+$/i.test(s) ? { host: `[${s}]` } : null;
  const m = s.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
  if (!m || !/^[a-z0-9.-]+$/i.test(m[1]!)) return null;
  const port = m[2] ? Number(m[2]) : undefined;
  if (port != null && (port < 1 || port > 65535)) return null;
  return { host: m[1]!, port };
}

/** True when the text is already a full stream link (pasted from the brand's app). */
export function isStreamLink(input: string): boolean {
  return /^rtsps?:\/\//i.test(input.trim());
}

const enc = (s: string) => encodeURIComponent(s);

export interface StreamInput {
  /** Camera address, or a full rtsp:// link pasted from the brand's app. */
  address: string;
  username?: string;
  password?: string;
  channel?: number;
}

/**
 * Builds the camera's stream link so nobody has to type one. A pasted link is kept as is,
 * with the account added when the link doesn't already carry one.
 */
export function buildStreamUrl(target: Pick<StreamTarget, 'template' | 'port'>, input: StreamInput): string {
  const user = input.username?.trim() ?? '';
  const pass = input.password ?? '';
  const auth = user ? `${enc(user)}:${enc(pass)}@` : '';

  if (isStreamLink(input.address)) {
    const link = input.address.trim();
    const m = link.match(/^(rtsps?:\/\/)([^/?#]*)(.*)$/i)!;
    const hasAuth = m[2]!.includes('@');
    return hasAuth || !auth ? link : `${m[1]}${auth}${m[2]}${m[3]}`;
  }

  const a = parseAddress(input.address);
  if (!a) throw new Error('That doesn’t look like a camera address. It should look like 192.168.1.50.');
  return target.template
    .replace('{auth}', auth)
    .replace('{host}', a.host)
    .replace('{port}', String(a.port ?? target.port))
    .replace('{channel}', String(input.channel ?? 1));
}

/** Same link with the password hidden, for showing on screen. */
export function redactStreamUrl(url: string): string {
  return url.replace(/^(rtsps?:\/\/[^:/@]*:)[^@/]*@/i, '$1•••@');
}

/** Whether a device's open ports look like this kind of camera. */
export function matchesScan(open: Set<number>, spec: ScanSpec): boolean {
  return spec.needAll ? spec.ports.every((p) => open.has(p)) : spec.ports.some((p) => open.has(p));
}
