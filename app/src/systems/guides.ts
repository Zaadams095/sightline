import { stringsFor, tr } from '../i18n/index.ts';
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

/**
 * Last step for every guide that continues in Sightline, in English (what tests compare with).
 * Screens get it in the user's language through stepsFor().
 */
export const COME_BACK_STEP = stringsFor('en').guides.comeBack;

// The text lives in i18n/<lang>/guides.ts and is read through getters, so it's always in the
// current language (never frozen at load). The guide data itself keeps the same shape.
const s = () => tr().guides;

interface OptionText {
  title?: string;
  detail?: string;
  steps?: string[];
}

/** One option, its title/detail/steps read in the current language. */
const option = (id: string, text: () => OptionText, target: GuideTarget, title?: string): GuideOption => ({
  id,
  get title() {
    return title ?? text().title ?? '';
  },
  get detail() {
    return text().detail;
  },
  get steps() {
    return text().steps ?? [];
  },
  target,
});

interface StreamText {
  usernameLabel?: string;
  usernameHint?: string;
  passwordLabel?: string;
  passwordHint?: string;
  cameraName: string;
}

const stream = (base: Omit<StreamTarget, keyof StreamText>, text: () => StreamText): StreamTarget => ({
  ...base,
  get usernameLabel() {
    return text().usernameLabel;
  },
  get usernameHint() {
    return text().usernameHint;
  },
  get passwordLabel() {
    return text().passwordLabel;
  },
  get passwordHint() {
    return text().passwordHint;
  },
  get cameraName() {
    return text().cameraName;
  },
});

const unsupported = (why: () => string, alternatives: Alternative[]): UnsupportedTarget => ({
  type: 'unsupported',
  get why() {
    return why();
  },
  alternatives,
});

/** "Try this other guide instead" button. */
const toGuide = (label: () => string, guide: string, opt?: string): Alternative => ({
  get label() {
    return label();
  },
  action: 'guide',
  guide,
  ...(opt ? { option: opt } : {}),
});

const PICK_ANOTHER: Alternative = {
  get label() {
    return s().alt.pickAnother;
  },
  action: 'brands',
};
const FIND: Alternative = {
  get label() {
    return s().alt.findOnWifi;
  },
  action: 'discover',
};
const LINK: Alternative = {
  get label() {
    return s().alt.haveLink;
  },
  action: 'stream',
};

const CLOUD_ALTERNATIVES: Alternative[] = [
  {
    get label() {
      return s().alt.seeWorking;
    },
    action: 'brands',
  },
  FIND,
];

const cloud = (id: string, name: string, app: string, keywords: string[], why: () => string): BrandGuide => ({
  id,
  name,
  group: 'cloud',
  keywords,
  app,
  options: [option('all', () => ({}), unsupported(why, CLOUD_ALTERNATIVES), name)],
});

export const GUIDES: BrandGuide[] = [
  {
    id: 'tapo',
    name: 'TP-Link Tapo',
    group: 'camera',
    keywords: ['tapo', 'tp-link', 'tplink', 'tp link', 'c100', 'c110', 'c120', 'c200', 'c210', 'c220', 'c225', 'c310', 'c320', 'c500', 'c510', 'c520'],
    app: 'Tapo',
    options: [
      option(
        'plugin',
        () => s().tapo.plugin,
        stream(
          {
            type: 'stream',
            template: 'rtsp://{auth}{host}:{port}/stream1',
            port: 554,
            scan: { ports: [554, 2020], needAll: true },
          },
          () => s().tapo.plugin,
        ),
      ),
      option(
        'battery',
        () => s().tapo.battery,
        unsupported(
          () => s().tapo.battery.why,
          [toGuide(() => s().tapo.battery.usePlugin, 'tapo', 'plugin'), PICK_ANOTHER],
        ),
      ),
    ],
  },
  {
    id: 'wyze',
    name: 'Wyze',
    group: 'camera',
    keywords: ['wyze', 'cam v3', 'pan v3', 'v3', 'v4', 'og', 'wyze bridge'],
    app: 'Wyze',
    options: [
      option(
        'v3',
        () => s().wyze.v3,
        stream(
          {
            type: 'stream',
            template: 'rtsp://{auth}{host}:{port}/stream0',
            port: 554,
            pasteLink: true,
            scan: { ports: [554] },
          },
          () => s().wyze.v3,
        ),
      ),
      option('other', () => s().wyze.other, unsupported(() => s().wyze.other.why, [LINK, PICK_ANOTHER])),
    ],
  },
  {
    id: 'eufy',
    name: 'eufy',
    group: 'camera',
    keywords: ['eufy', 'eufycam', 'anker', 'indoor cam', 'homebase', 'eufy security', 'e220', 's350'],
    app: 'eufy Security',
    options: [
      option(
        'rtsp',
        () => s().eufy.rtsp,
        stream(
          {
            type: 'stream',
            template: 'rtsp://{auth}{host}:{port}/live0',
            port: 554,
            pasteLink: true,
            scan: { ports: [554] },
          },
          () => s().eufy.rtsp,
        ),
      ),
      option(
        'other',
        () => s().eufy.other,
        unsupported(() => s().eufy.other.why, [toGuide(() => s().eufy.other.checkAgain, 'eufy', 'rtsp'), PICK_ANOTHER]),
      ),
    ],
  },
  {
    id: 'imou',
    name: 'Imou',
    group: 'camera',
    keywords: ['imou', 'imou life', 'ranger', 'cruiser', 'bullet', 'cue', 'dahua'],
    app: 'Imou Life',
    options: [
      option(
        'camera',
        () => s().imou.camera,
        stream(
          {
            type: 'stream',
            template: 'rtsp://{auth}{host}:{port}/cam/realmonitor?channel={channel}&subtype=0',
            port: 554,
            username: 'admin',
            scan: { ports: [554] },
          },
          () => s().imou.camera,
        ),
      ),
    ],
  },
  {
    id: 'ezviz',
    name: 'EZVIZ',
    group: 'camera',
    keywords: ['ezviz', 'hikvision', 'c3', 'c6', 'c8', 'h6', 'h8'],
    app: 'EZVIZ',
    options: [
      option(
        'camera',
        () => s().ezviz.camera,
        stream(
          {
            type: 'stream',
            template: 'rtsp://{auth}{host}:{port}/h264/ch1/main/av_stream',
            port: 554,
            username: 'admin',
            scan: { ports: [554] },
          },
          () => s().ezviz.camera,
        ),
      ),
    ],
  },
  {
    id: 'kasa',
    name: 'Kasa',
    group: 'camera',
    keywords: ['kasa', 'kasa smart', 'tp-link', 'kc', 'ec', 'spot'],
    app: 'Kasa Smart',
    options: [
      option(
        'all',
        () => s().kasa.all,
        unsupported(() => s().kasa.all.why, [toGuide(() => s().kasa.all.useTapo, 'tapo'), PICK_ANOTHER]),
      ),
    ],
  },
  {
    id: 'reolink',
    name: 'Reolink',
    group: 'recorder',
    keywords: ['reolink', 'argus', 'e1', 'rlc', 'duo', 'home hub', 'altas', 'lumus', 'trackmix'],
    app: 'Reolink',
    options: [
      option('wired', () => s().reolink.wired, { type: 'system', system: 'reolink', name: 'Reolink', username: 'admin' }),
      option(
        'battery',
        () => s().reolink.battery,
        unsupported(
          () => s().reolink.battery.why,
          [toGuide(() => s().reolink.battery.haveHub, 'reolink', 'wired'), PICK_ANOTHER],
        ),
      ),
      option('lte', () => s().reolink.lte, unsupported(() => s().reolink.lte.why, [PICK_ANOTHER])),
    ],
  },
  {
    id: 'amcrest',
    name: 'Amcrest',
    group: 'recorder',
    keywords: ['amcrest', 'amcrest smart home', 'amcrest view', 'ash', 'ip2m', 'ip4m', 'ip5m', 'ip8m', 'dahua'],
    get app() {
      return s().apps.amcrest;
    },
    options: [option('all', () => s().amcrest.all, { type: 'system', system: 'dahua', name: 'Amcrest', username: 'admin' })],
  },
  {
    id: 'lorex',
    name: 'Lorex',
    group: 'recorder',
    keywords: ['lorex', 'lorex home', 'lorex cloud', 'fusion', 'nvr', 'dvr'],
    get app() {
      return s().apps.lorex;
    },
    options: [
      option('recorder', () => s().lorex.recorder, { type: 'system', system: 'dahua', name: 'Lorex', username: 'admin' }),
      option(
        'wifi',
        () => s().lorex.wifi,
        unsupported(
          () => s().lorex.wifi.why,
          [toGuide(() => s().lorex.wifi.onRecorder, 'lorex', 'recorder'), FIND, PICK_ANOTHER],
        ),
      ),
    ],
  },
  {
    id: 'swann',
    name: 'Swann',
    group: 'recorder',
    keywords: ['swann', 'swann security', 'swannview', 'nvr', 'dvr'],
    app: 'Swann Security',
    options: [
      option('recorder', () => s().swann.recorder, { type: 'system', system: 'onvif', name: 'Swann', username: 'admin' }),
      option(
        'wifi',
        () => s().swann.wifi,
        unsupported(
          () => s().swann.wifi.why,
          [toGuide(() => s().swann.wifi.haveRecorder, 'swann', 'recorder'), PICK_ANOTHER],
        ),
      ),
    ],
  },
  {
    id: 'annke',
    name: 'Annke',
    group: 'recorder',
    keywords: ['annke', 'annke vision', 'hikvision', 'nvr', 'dvr'],
    app: 'Annke Vision',
    options: [option('all', () => s().annke.all, { type: 'system', system: 'hikvision', name: 'Annke', username: 'admin' })],
  },
  {
    id: 'hikvision',
    name: 'Hikvision',
    group: 'recorder',
    // Hikvision makes cameras and recorders sold under other names too.
    keywords: ['hikvision', 'hik-connect', 'hik connect', 'hiwatch', 'lts', 'lt security', 'nvr', 'dvr'],
    app: 'Hik-Connect',
    options: [option('all', () => s().hikvision.all, { type: 'system', system: 'hikvision', name: 'Hikvision', username: 'admin' })],
  },
  {
    id: 'dahua',
    name: 'Dahua',
    group: 'recorder',
    keywords: ['dahua', 'dmss', 'nvr', 'xvr'],
    app: 'DMSS',
    options: [option('all', () => s().dahua.all, { type: 'system', system: 'dahua', name: 'Dahua', username: 'admin' })],
  },
  {
    id: 'ubiquiti',
    name: 'Ubiquiti UniFi',
    group: 'recorder',
    keywords: ['ubiquiti', 'unifi', 'protect', 'g4', 'g5', 'dream machine', 'udm', 'cloud key', 'ucg'],
    app: 'UniFi Protect',
    options: [option('all', () => s().ubiquiti.all, { type: 'system', system: 'unifi-protect', name: 'UniFi Protect' }, 'UniFi Protect')],
  },
  cloud('ring', 'Ring', 'Ring', ['ring', 'amazon', 'doorbell', 'stick up', 'spotlight'], () => s().cloudWhy.ring),
  cloud('nest', 'Google Nest', 'Google Home', ['nest', 'google', 'google home', 'dropcam', 'doorbell'], () => s().cloudWhy.nest),
  cloud('arlo', 'Arlo', 'Arlo Secure', ['arlo', 'netgear', 'essential', 'pro', 'ultra'], () => s().cloudWhy.arlo),
  cloud('blink', 'Blink', 'Blink Home Monitor', ['blink', 'amazon', 'outdoor', 'mini', 'sync module'], () => s().cloudWhy.blink),
  cloud('simplisafe', 'SimpliSafe', 'SimpliSafe', ['simplisafe', 'simply safe', 'simplicam'], () => s().cloudWhy.simplisafe),
];

export const GROUP_TITLES: Record<GuideGroup, string> = {
  get camera() {
    return s().groups.camera;
  },
  get recorder() {
    return s().groups.recorder;
  },
  get cloud() {
    return s().groups.cloud;
  },
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
  return [...option.steps, tr().guides.comeBack];
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
  if (!a) throw new Error(tr().guides.badAddress);
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
