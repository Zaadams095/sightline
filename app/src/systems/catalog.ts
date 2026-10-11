import type { SystemKind } from '@/systems/types';

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

export type Category = 'recorder' | 'software' | 'camera' | 'hub';

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
    available: false,
    defaultPorts: [{ port: 8086, https: false }],
    addressHint: 'Shown on the Hub’s setup page. Easiest: scan its QR code.',
    fields: [ADDRESS('192.168.1.20:8086', 'Or scan the QR code on the Hub setup page.'), { key: 'code', label: 'Pairing code', placeholder: '6 digits' }],
    fingerprints: [{ port: 8086, https: false, path: '/v1/info', match: (r) => has(r.body, 'sightline') || has(r.server, 'sightline') }],
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
    available: false,
    defaultPorts: [
      { port: 443, https: true },
      { port: 80, https: false },
    ],
    addressHint: 'In the Reolink app: Settings → Device info → IP address.',
    fields: [ADDRESS('192.168.1.20', 'The recorder (or single camera) address.'), USER(), PASS],
    fingerprints: [
      { port: 80, https: false, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
      { port: 443, https: true, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
    ],
  },
  {
    kind: 'hikvision',
    label: 'Hikvision',
    blurb: 'Hikvision recorders and cameras (also many rebranded ones)',
    category: 'recorder',
    available: false,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    addressHint: 'Printed on the recorder, or in Hik-Connect: device → Device information.',
    fields: [ADDRESS('192.168.1.64', 'The recorder (or camera) address.'), USER(), PASS],
    fingerprints: [
      { port: 80, https: false, path: '/ISAPI/System/deviceInfo', match: (r) => r.status === 401 && (has(r.server, 'webs') || has(r.auth, 'digest')) },
      { port: 443, https: true, path: '/ISAPI/System/deviceInfo', match: (r) => r.status === 401 && (has(r.server, 'webs') || has(r.auth, 'digest')) },
    ],
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
    blurb: 'Ubiquiti Cloud Key, UNVR, Dream Machine, Cloud Gateway',
    category: 'recorder',
    available: true,
    defaultPorts: [{ port: 443, https: true }],
    addressHint:
      'Your UniFi console’s address (often 192.168.1.1). Sign in with a local account: in UniFi OS open Admins & Users → add an admin, choose “Restrict to local access only”, and give it access to Protect.',
    fields: [
      ADDRESS('192.168.1.1', 'The address of your Cloud Key, Dream Machine or NVR.'),
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
    available: false,
    defaultPorts: [
      { port: 81, https: false },
      { port: 80, https: false },
    ],
    addressHint: 'Blue Iris settings → Web server → LAN address (often port 81).',
    fields: [ADDRESS('192.168.1.30:81', 'Blue Iris web server address.'), USER(''), PASS],
    fingerprints: [{ port: 81, https: false, path: '/', match: (r) => has(r.body, 'blue iris') }],
  },
  {
    kind: 'scrypted',
    label: 'Scrypted',
    blurb: 'Home video platform',
    category: 'software',
    available: false,
    defaultPorts: [{ port: 10443, https: true }],
    addressHint: 'The address you open Scrypted at (port 10443).',
    fields: [ADDRESS('192.168.1.40:10443', 'Scrypted address.'), USER(''), PASS],
    fingerprints: [{ port: 10443, https: true, path: '/', match: (r) => has(r.body, 'scrypted') }],
  },
  {
    kind: 'zoneminder',
    label: 'ZoneMinder',
    blurb: 'Open-source camera software',
    category: 'software',
    available: false,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    addressHint: 'The address you open ZoneMinder at (usually /zm).',
    fields: [ADDRESS('192.168.1.50', 'ZoneMinder address.'), USER(''), PASS],
    fingerprints: [{ port: 80, https: false, path: '/zm/', match: (r) => has(r.body, 'zoneminder') }],
  },
  {
    kind: 'shinobi',
    label: 'Shinobi',
    blurb: 'Open-source camera software',
    category: 'software',
    available: false,
    defaultPorts: [{ port: 8080, https: false }],
    addressHint: 'The address you open Shinobi at (port 8080).',
    fields: [ADDRESS('192.168.1.50:8080', 'Shinobi address.'), USER(''), PASS],
    fingerprints: [{ port: 8080, https: false, path: '/', match: (r) => has(r.body, 'shinobi') }],
  },
  {
    kind: 'agent-dvr',
    label: 'Agent DVR',
    blurb: 'iSpy Agent DVR',
    category: 'software',
    available: false,
    defaultPorts: [{ port: 8090, https: false }],
    addressHint: 'The address you open Agent DVR at (port 8090).',
    fields: [ADDRESS('192.168.1.50:8090', 'Agent DVR address.'), { ...USER(''), optional: true }, { ...PASS, optional: true }],
    fingerprints: [{ port: 8090, https: false, path: '/', match: (r) => has(r.body, 'agent') }],
  },
  {
    kind: 'onvif',
    label: 'Camera (ONVIF)',
    blurb: 'Most IP cameras: just the address and password',
    category: 'camera',
    available: false,
    defaultPorts: [
      { port: 80, https: false },
      { port: 8000, https: false },
    ],
    addressHint: 'The camera’s address from your router’s device list or the camera’s app.',
    fields: [ADDRESS('192.168.1.70', 'The camera address.'), USER(), PASS],
    fingerprints: [
      { port: 80, https: false, path: '/onvif/device_service', match: (r) => [400, 405, 415, 500].includes(r.status) || has(r.body, 'soap') },
    ],
  },
  {
    kind: 'rtsp',
    label: 'Camera by stream link',
    blurb: 'Any camera with an RTSP link (advanced)',
    category: 'camera',
    available: true,
    defaultPorts: [],
    addressHint: 'The RTSP link from the camera manual, e.g. rtsp://user:pass@192.168.1.50:554/stream1.',
    fields: [],
    fingerprints: [],
  },
];

export function describe(kind: SystemKind): SystemDescriptor {
  return CATALOG.find((d) => d.kind === kind)!;
}

/** Every port worth scanning during discovery (plus RTSP, which marks "some camera is here"). */
export function discoveryPorts(): number[] {
  const ports = new Set<number>([554]);
  for (const d of CATALOG) for (const f of d.fingerprints) ports.add(f.port);
  return [...ports].sort((a, b) => a - b);
}
