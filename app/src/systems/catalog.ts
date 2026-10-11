import type { SystemKind } from '@/systems/types';
import type { AuthKind } from '@modules/wg-tunnel';

/**
 * Every supported system, described in plain language. Onboarding, setup forms and network
 * discovery are all generated from this list, so no brand gets a special-cased screen.
 */

export interface SetupField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  secure?: boolean;
  optional?: boolean;
  keyboard?: 'default' | 'url' | 'number-pad';
  defaultValue?: string;
}

/** Result of an HTTP probe used to recognize a device during network discovery. */
export interface ProbeResult {
  status: number;
  server: string;
  auth: string;
  body: string;
  error?: string;
}

export interface Fingerprint {
  port: number;
  https: boolean;
  path: string;
  match: (r: ProbeResult) => boolean;
}

/** 'demo' = the built-in sample cameras; never listed as a brand. */
export type Category = 'recorder' | 'software' | 'camera' | 'hub' | 'demo';

export interface SystemDescriptor {
  kind: SystemKind;
  label: string;
  blurb: string;
  category: Category;
  available: boolean;
  /** Ports to try, in order, when the user types only an address. */
  defaultPorts: { port: number; https: boolean }[];
  /** Plain-language help for finding the address. */
  addressHint: string;
  fields: SetupField[];
  fingerprints: Fingerprint[];
  /** How the gateway signs in (default: 'http' = answer Basic/Digest when a username is set). */
  gatewayAuth?: AuthKind;
  /** False for systems the app never reaches over HTTP (cameras added by stream link). */
  usesGateway?: boolean;
}

const ADDRESS = (placeholder: string, hint: string): SetupField => ({
  key: 'address',
  label: 'Address',
  placeholder,
  hint,
  keyboard: 'url',
});
const USER = (defaultValue = 'admin'): SetupField => ({ key: 'username', label: 'Username', defaultValue });
const PASS: SetupField = { key: 'password', label: 'Password', secure: true };

const has = (s: string | undefined, needle: string) => !!s && s.toLowerCase().includes(needle.toLowerCase());

export const CATALOG: SystemDescriptor[] = [
  {
    kind: 'hub',
    label: 'Sightline Hub',
    blurb: 'Instant alerts, sharing and remote access for any system',
    category: 'hub',
    available: true,
    defaultPorts: [{ port: 8086, https: false }],
    addressHint: 'Shown on the Hub’s setup page. Easiest: scan its QR code.',
    fields: [
      ADDRESS('192.168.1.20:8086', 'Or scan the QR code on the Hub setup page.'),
      { key: 'code', label: 'Pairing code', placeholder: '6 digits', keyboard: 'number-pad', hint: 'Shown on the Hub’s setup page.' },
    ],
    fingerprints: [{ port: 8086, https: false, path: '/v1/info', match: (r) => has(r.body, '"sightline":"hub"') || has(r.server, 'sightline') }],
  },
  {
    kind: 'frigate',
    label: 'Frigate',
    blurb: 'AI-powered recorder for any camera',
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 8971, https: true },
      { port: 5000, https: false },
      { port: 443, https: true },
      { port: 80, https: false },
    ],
    addressHint: 'The address you open Frigate at in a browser, e.g. 192.168.1.10:8971.',
    gatewayAuth: 'frigate',
    fields: [ADDRESS('192.168.1.10:8971', 'Port is optional; Sightline finds it.'), { ...USER(''), optional: true }, { ...PASS, optional: true }],
    fingerprints: [
      { port: 8971, https: true, path: '/', match: (r) => has(r.body, 'frigate') },
      { port: 8971, https: false, path: '/', match: (r) => has(r.body, 'frigate') },
      { port: 5000, https: false, path: '/api/version', match: (r) => r.status === 200 && /^\d+\.\d+/.test(r.body.trim()) },
    ],
  },
  {
    kind: 'reolink',
    label: 'Reolink',
    blurb: 'Reolink recorders, Home Hub and cameras',
    category: 'recorder',
    available: true,
    // Newer Reolink firmware ships with HTTPS on and plain HTTP off.
    defaultPorts: [
      { port: 443, https: true },
      { port: 80, https: false },
    ],
    addressHint:
      'In the Reolink app, open the device’s settings and look for Network Information (or Device Info) to see its IP address. Use the recorder or Home Hub address if you have one.',
    fields: [
      ADDRESS('192.168.1.20', 'The recorder, Home Hub or single camera address.'),
      USER(),
      { ...PASS, hint: 'The password you use in the Reolink app for this device.' },
    ],
    // Without a token the API still answers JSON naming the command ("please login first").
    fingerprints: [
      { port: 443, https: true, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
      { port: 80, https: false, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
    ],
  },
  {
    kind: 'hikvision',
    label: 'Hikvision',
    blurb: 'Hikvision recorders and cameras (also many rebranded ones)',
    category: 'recorder',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    addressHint:
      'On the recorder’s screen: Menu → Configuration → Network → General shows the IPv4 address. For a single camera, look for it in your router’s list of connected devices.',
    fields: [
      ADDRESS('192.168.1.64', 'The recorder (or camera) address.'),
      USER(),
      { ...PASS, hint: 'The password you sign in to the recorder with (not your Hik-Connect account).' },
    ],
    // ISAPI answers a Digest challenge. Dahua-based devices also use Digest but with a
    // "Login to <serial>" realm, so those are left to the Dahua entry.
    fingerprints: [80, 443].map((port) => ({
      port,
      https: port === 443,
      path: '/ISAPI/System/deviceInfo',
      match: (r: ProbeResult) =>
        has(r.body, '<DeviceInfo') || (r.status === 401 && !has(r.auth, 'login to') && (has(r.server, 'webs') || has(r.auth, 'digest'))),
    })),
  },
  {
    kind: 'dahua',
    label: 'Dahua / Amcrest / Lorex',
    blurb: 'Dahua, Amcrest and Lorex recorders and cameras',
    category: 'recorder',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    addressHint:
      'On the recorder’s screen: Main Menu → Network shows the IP address. In the Amcrest or Lorex app, open the device’s settings → Device info.',
    fields: [
      ADDRESS('192.168.1.108', 'The recorder’s address (or a single camera’s).'),
      { ...USER(), hint: 'The same sign-in you use on the recorder’s screen or in its app.' },
      PASS,
    ],
    // Dahua firmware answers with a Digest challenge whose realm is "Login to <serial>".
    fingerprints: [
      { port: 80, https: false, path: '/cgi-bin/magicBox.cgi?action=getDeviceType', match: (r) => has(r.auth, 'login to') || has(r.body, 'type=') },
      { port: 443, https: true, path: '/cgi-bin/magicBox.cgi?action=getDeviceType', match: (r) => has(r.auth, 'login to') || has(r.body, 'type=') },
    ],
  },
  {
    kind: 'unifi-protect',
    label: 'UniFi Protect',
    blurb: 'UniFi cameras on a Cloud Key, Dream Machine or UniFi recorder',
    category: 'recorder',
    available: true,
    defaultPorts: [{ port: 443, https: true }],
    addressHint:
      'Your UniFi console’s address (often 192.168.1.1). Sign in with a local account: in UniFi OS open Admins & Users → add an admin, choose “Restrict to local access only”, and give it access to Protect.',
    fields: [
      ADDRESS('192.168.1.1', 'The address of your Cloud Key, Dream Machine or UniFi recorder.'),
      { ...USER(''), hint: 'A local UniFi account, not your Ubiquiti cloud email.' },
      PASS,
    ],
    fingerprints: [{ port: 443, https: true, path: '/', match: (r) => has(r.body, 'unifi') }],
  },
  {
    kind: 'blue-iris',
    label: 'Blue Iris',
    blurb: 'Windows camera software',
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 81, https: false },
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    addressHint: 'On the Blue Iris computer: Settings → Web server shows the local address (often port 81). Sign in with a Blue Iris user from Settings → Users.',
    fields: [
      ADDRESS('192.168.1.30:81', 'Port is optional; Sightline tries 81 first.'),
      { ...USER(''), hint: 'A Blue Iris user (Settings → Users). Leave empty if Blue Iris allows anonymous viewing.', optional: true },
      { ...PASS, optional: true },
    ],
    fingerprints: [
      // The JSON login's first step answers with a session key even without a password.
      { port: 81, https: false, path: '/', match: (r) => has(r.body, 'blue iris') || has(r.server, 'blueserver') },
      { port: 80, https: false, path: '/', match: (r) => has(r.body, 'blue iris') || has(r.server, 'blueserver') },
    ],
  },
  {
    kind: 'scrypted',
    label: 'Scrypted',
    blurb: 'Home video software (live view, added camera by camera)',
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 10443, https: true },
      { port: 11080, https: false },
    ],
    addressHint:
      'The address you open Scrypted at (port 10443). Then, for each camera in Scrypted: open the camera → Rebroadcast → Streams, copy “RTSP Rebroadcast Url” and paste it below.',
    fields: [
      ADDRESS('192.168.1.40:10443', 'Used to fill in “localhost” in the links.'),
      {
        key: 'links',
        label: 'Camera links',
        placeholder: 'Porch=rtsp://localhost:34567/a1b2…',
        hint: 'Paste each camera’s “RTSP Rebroadcast Url”, separated by spaces. To name a camera, put its name and = in front, like Porch=rtsp://….',
        keyboard: 'url',
      },
      { ...USER(''), hint: 'Optional: your Scrypted sign-in, to check the address.', optional: true },
      { ...PASS, optional: true },
    ],
    fingerprints: [{ port: 10443, https: true, path: '/', match: (r) => has(r.body, 'scrypted') }],
  },
  {
    kind: 'zoneminder',
    label: 'ZoneMinder',
    blurb: 'Open-source camera software',
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
      { port: 8443, https: true },
    ],
    addressHint: 'The address you open ZoneMinder at, without “/zm” (e.g. 192.168.1.50). The user needs API access (Options → Users).',
    fields: [
      ADDRESS('192.168.1.50', 'Leave off /zm; Sightline finds it.'),
      { ...USER(''), hint: 'Leave empty if ZoneMinder doesn’t ask you to sign in.', optional: true },
      { ...PASS, optional: true },
    ],
    fingerprints: [
      { port: 80, https: false, path: '/zm/', match: (r) => has(r.body, 'zoneminder') },
      { port: 80, https: false, path: '/zm/api/host/getVersion.json', match: (r) => has(r.body, 'apiversion') },
      { port: 443, https: true, path: '/zm/', match: (r) => has(r.body, 'zoneminder') },
    ],
  },
  {
    kind: 'shinobi',
    label: 'Shinobi',
    blurb: 'Open-source camera software',
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 8080, https: false },
      { port: 443, https: true },
    ],
    addressHint: 'The address you open Shinobi at (port 8080). Sightline signs in with an API key instead of your password.',
    fields: [
      ADDRESS('192.168.1.50:8080', 'Port is optional; Sightline tries 8080 first.'),
      {
        // Stored in the keychain like a password.
        key: 'password',
        label: 'API key',
        placeholder: 'Paste the API key',
        hint: 'In Shinobi, open the menu (your name, top left) → API Keys. Tick the permissions. Under Allowed IPs, enter this phone’s address (iPhone Settings → Wi-Fi → tap ⓘ next to your network → IP Address). Tap Add, then copy the key.',
        secure: true,
      },
      {
        key: 'groupKey',
        label: 'Group key',
        placeholder: 'e.g. aBcD1234',
        hint: 'In Shinobi, open the menu → Account Settings. The group key is shown at the top.',
      },
    ],
    fingerprints: [{ port: 8080, https: false, path: '/', match: (r) => has(r.body, 'shinobi') }],
  },
  {
    kind: 'agent-dvr',
    label: 'Agent DVR',
    blurb: 'Camera software by iSpy',
    category: 'software',
    available: true,
    defaultPorts: [{ port: 8090, https: false }],
    addressHint: 'The address you open Agent DVR at (port 8090). For recordings to play on iPhone, set each camera’s recording format to MP4.',
    fields: [
      ADDRESS('192.168.1.50:8090', 'Port is optional; Sightline tries 8090 first.'),
      { ...USER(''), hint: 'Only if “Protect API” is turned on in Agent’s server settings.', optional: true },
      { ...PASS, optional: true },
    ],
    fingerprints: [
      // getStatus answers JSON with version/unique/armed (agent-py); a 401 means "Protect API" is on.
      { port: 8090, https: false, path: '/command/getStatus', match: (r) => (has(r.body, '"unique"') && has(r.body, '"version"')) || (r.status === 401 && has(r.auth, 'basic')) },
      { port: 8090, https: false, path: '/', match: (r) => has(r.body, 'agent dvr') || has(r.body, 'ispy') },
    ],
  },
  {
    kind: 'onvif',
    label: 'Other network camera',
    blurb: 'Most Wi-Fi and wired cameras: just the address and password',
    category: 'camera',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 8000, https: false },
      { port: 2020, https: false },
      { port: 8899, https: false },
    ],
    addressHint: 'The camera’s address from your router’s device list or the camera’s app. Sign in with the same login you use in the camera’s app or web page.',
    fields: [
      ADDRESS(
        '192.168.1.70',
        'Just the address is usually enough. If it doesn’t connect, turn on “ONVIF” (the standard way apps talk to cameras) in the camera’s app, and add the port it shows, e.g. 192.168.1.70:8000.',
      ),
      { ...USER(), hint: 'Often “admin”. Some cameras need a separate camera account, made in their app.' },
      { ...PASS, hint: 'The camera’s password (not your Wi-Fi password).' },
    ],
    fingerprints: [80, 8000, 2020, 8899].map((port) => ({
      port,
      https: false,
      path: '/onvif/device_service',
      match: (r: ProbeResult) => [400, 405, 415, 500].includes(r.status) || has(r.body, 'soap') || has(r.body, 'onvif'),
    })),
  },
  {
    kind: 'rtsp',
    label: 'Camera by stream link',
    blurb: 'Paste a video link from the camera’s manual (advanced)',
    category: 'camera',
    available: true,
    defaultPorts: [],
    addressHint: 'The video link (starts with rtsp://) from the camera’s manual, e.g. rtsp://user:pass@192.168.1.50:554/stream1.',
    usesGateway: false,
    fields: [],
    fingerprints: [],
  },
  {
    kind: 'demo',
    label: 'Sample cameras',
    blurb: 'Built-in sample video to explore the app',
    category: 'demo',
    available: true,
    defaultPorts: [],
    addressHint: '',
    usesGateway: false,
    fields: [],
    fingerprints: [],
  },
];

export function describe(kind: SystemKind): SystemDescriptor {
  return CATALOG.find((d) => d.kind === kind)!;
}

export function usesGateway(kind: SystemKind): boolean {
  return describe(kind)?.usesGateway !== false;
}

/** Every port worth scanning during discovery (plus RTSP, which marks "some camera is here"). */
export function discoveryPorts(): number[] {
  const ports = new Set<number>([554]);
  for (const d of CATALOG) for (const f of d.fingerprints) ports.add(f.port);
  return [...ports].sort((a, b) => a - b);
}
