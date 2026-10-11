import { tr } from '@/i18n';
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

// Text is read in the current language each time a screen asks (getters below), never at load.
const c = () => tr().onboarding.catalog;

const ADDRESS = (placeholder: string, hint: string): SetupField => ({
  key: 'address',
  label: c().address,
  placeholder,
  hint,
  keyboard: 'url',
});
const USER = (defaultValue = 'admin'): SetupField => ({ key: 'username', label: c().username, defaultValue });
const PASS = (): SetupField => ({ key: 'password', label: c().password, secure: true });

const has = (s: string | undefined, needle: string) => !!s && s.toLowerCase().includes(needle.toLowerCase());

export const CATALOG: SystemDescriptor[] = [
  {
    kind: 'hub',
    label: 'Sightline Hub',
    get blurb() {
      return c().hub.blurb;
    },
    category: 'hub',
    available: true,
    defaultPorts: [{ port: 8086, https: false }],
    get addressHint() {
      return c().hub.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().hub;
      return [
        ADDRESS('192.168.1.20:8086', s.addressHelp),
        { key: 'code', label: s.code, placeholder: s.codePlaceholder, keyboard: 'number-pad', hint: s.codeHint },
      ];
    },
    fingerprints: [{ port: 8086, https: false, path: '/v1/info', match: (r) => has(r.body, '"sightline":"hub"') || has(r.server, 'sightline') }],
  },
  {
    kind: 'frigate',
    label: 'Frigate',
    get blurb() {
      return c().frigate.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 8971, https: true },
      { port: 5000, https: false },
      { port: 443, https: true },
      { port: 80, https: false },
    ],
    get addressHint() {
      return c().frigate.addressHint;
    },
    gatewayAuth: 'frigate',
    get fields(): SetupField[] {
      return [ADDRESS('192.168.1.10:8971', c().frigate.addressHelp), { ...USER(''), optional: true }, { ...PASS(), optional: true }];
    },
    fingerprints: [
      { port: 8971, https: true, path: '/', match: (r) => has(r.body, 'frigate') },
      { port: 8971, https: false, path: '/', match: (r) => has(r.body, 'frigate') },
      { port: 5000, https: false, path: '/api/version', match: (r) => r.status === 200 && /^\d+\.\d+/.test(r.body.trim()) },
    ],
  },
  {
    kind: 'reolink',
    label: 'Reolink',
    get blurb() {
      return c().reolink.blurb;
    },
    category: 'recorder',
    available: true,
    // Newer Reolink firmware ships with HTTPS on and plain HTTP off.
    defaultPorts: [
      { port: 443, https: true },
      { port: 80, https: false },
    ],
    get addressHint() {
      return c().reolink.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().reolink;
      return [ADDRESS('192.168.1.20', s.addressHelp), USER(), { ...PASS(), hint: s.passwordHint }];
    },
    // Without a token the API still answers JSON naming the command ("please login first").
    fingerprints: [
      { port: 443, https: true, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
      { port: 80, https: false, path: '/cgi-bin/api.cgi?cmd=GetDevInfo', match: (r) => has(r.body, '"cmd"') && has(r.body, 'GetDevInfo') },
    ],
  },
  {
    kind: 'hikvision',
    label: 'Hikvision',
    get blurb() {
      return c().hikvision.blurb;
    },
    category: 'recorder',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    get addressHint() {
      return c().hikvision.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().hikvision;
      return [ADDRESS('192.168.1.64', s.addressHelp), USER(), { ...PASS(), hint: s.passwordHint }];
    },
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
    get blurb() {
      return c().dahua.blurb;
    },
    category: 'recorder',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    get addressHint() {
      return c().dahua.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().dahua;
      return [ADDRESS('192.168.1.108', s.addressHelp), { ...USER(), hint: s.usernameHint }, PASS()];
    },
    // Dahua firmware answers with a Digest challenge whose realm is "Login to <serial>".
    fingerprints: [
      { port: 80, https: false, path: '/cgi-bin/magicBox.cgi?action=getDeviceType', match: (r) => has(r.auth, 'login to') || has(r.body, 'type=') },
      { port: 443, https: true, path: '/cgi-bin/magicBox.cgi?action=getDeviceType', match: (r) => has(r.auth, 'login to') || has(r.body, 'type=') },
    ],
  },
  {
    kind: 'unifi-protect',
    label: 'UniFi Protect',
    get blurb() {
      return c().unifi.blurb;
    },
    category: 'recorder',
    available: true,
    defaultPorts: [{ port: 443, https: true }],
    get addressHint() {
      return c().unifi.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().unifi;
      return [ADDRESS('192.168.1.1', s.addressHelp), { ...USER(''), hint: s.usernameHint }, PASS()];
    },
    fingerprints: [{ port: 443, https: true, path: '/', match: (r) => has(r.body, 'unifi') }],
  },
  {
    kind: 'blue-iris',
    label: 'Blue Iris',
    get blurb() {
      return c().blueIris.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 81, https: false },
      { port: 80, https: false },
      { port: 443, https: true },
    ],
    get addressHint() {
      return c().blueIris.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().blueIris;
      return [ADDRESS('192.168.1.30:81', s.addressHelp), { ...USER(''), hint: s.usernameHint, optional: true }, { ...PASS(), optional: true }];
    },
    fingerprints: [
      // The JSON login's first step answers with a session key even without a password.
      { port: 81, https: false, path: '/', match: (r) => has(r.body, 'blue iris') || has(r.server, 'blueserver') },
      { port: 80, https: false, path: '/', match: (r) => has(r.body, 'blue iris') || has(r.server, 'blueserver') },
    ],
  },
  {
    kind: 'scrypted',
    label: 'Scrypted',
    get blurb() {
      return c().scrypted.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 10443, https: true },
      { port: 11080, https: false },
    ],
    get addressHint() {
      return c().scrypted.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().scrypted;
      return [
        ADDRESS('192.168.1.40:10443', s.addressHelp),
        {
          key: 'links',
          label: s.links,
          placeholder: s.linksPlaceholder,
          hint: s.linksHint,
          keyboard: 'url',
        },
        { ...USER(''), hint: s.usernameHint, optional: true },
        { ...PASS(), optional: true },
      ];
    },
    fingerprints: [{ port: 10443, https: true, path: '/', match: (r) => has(r.body, 'scrypted') }],
  },
  {
    kind: 'zoneminder',
    label: 'ZoneMinder',
    get blurb() {
      return c().zoneminder.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 443, https: true },
      { port: 8443, https: true },
    ],
    get addressHint() {
      return c().zoneminder.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().zoneminder;
      return [ADDRESS('192.168.1.50', s.addressHelp), { ...USER(''), hint: s.usernameHint, optional: true }, { ...PASS(), optional: true }];
    },
    fingerprints: [
      { port: 80, https: false, path: '/zm/', match: (r) => has(r.body, 'zoneminder') },
      { port: 80, https: false, path: '/zm/api/host/getVersion.json', match: (r) => has(r.body, 'apiversion') },
      { port: 443, https: true, path: '/zm/', match: (r) => has(r.body, 'zoneminder') },
    ],
  },
  {
    kind: 'shinobi',
    label: 'Shinobi',
    get blurb() {
      return c().shinobi.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [
      { port: 8080, https: false },
      { port: 443, https: true },
    ],
    get addressHint() {
      return c().shinobi.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().shinobi;
      return [
        ADDRESS('192.168.1.50:8080', s.addressHelp),
        {
          // Stored in the keychain like a password.
          key: 'password',
          label: s.apiKey,
          placeholder: s.apiKeyPlaceholder,
          hint: s.apiKeyHint,
          secure: true,
        },
        {
          key: 'groupKey',
          label: s.groupKey,
          placeholder: s.groupKeyPlaceholder,
          hint: s.groupKeyHint,
        },
      ];
    },
    fingerprints: [{ port: 8080, https: false, path: '/', match: (r) => has(r.body, 'shinobi') }],
  },
  {
    kind: 'agent-dvr',
    label: 'Agent DVR',
    get blurb() {
      return c().agentDvr.blurb;
    },
    category: 'software',
    available: true,
    defaultPorts: [{ port: 8090, https: false }],
    get addressHint() {
      return c().agentDvr.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().agentDvr;
      return [ADDRESS('192.168.1.50:8090', s.addressHelp), { ...USER(''), hint: s.usernameHint, optional: true }, { ...PASS(), optional: true }];
    },
    fingerprints: [
      // getStatus answers JSON with version/unique/armed (agent-py); a 401 means "Protect API" is on.
      { port: 8090, https: false, path: '/command/getStatus', match: (r) => (has(r.body, '"unique"') && has(r.body, '"version"')) || (r.status === 401 && has(r.auth, 'basic')) },
      { port: 8090, https: false, path: '/', match: (r) => has(r.body, 'agent dvr') || has(r.body, 'ispy') },
    ],
  },
  {
    kind: 'onvif',
    get label() {
      return c().onvif.label;
    },
    get blurb() {
      return c().onvif.blurb;
    },
    category: 'camera',
    available: true,
    defaultPorts: [
      { port: 80, https: false },
      { port: 8000, https: false },
      { port: 2020, https: false },
      { port: 8899, https: false },
    ],
    get addressHint() {
      return c().onvif.addressHint;
    },
    get fields(): SetupField[] {
      const s = c().onvif;
      return [ADDRESS('192.168.1.70', s.addressHelp), { ...USER(), hint: s.usernameHint }, { ...PASS(), hint: s.passwordHint }];
    },
    fingerprints: [80, 8000, 2020, 8899].map((port) => ({
      port,
      https: false,
      path: '/onvif/device_service',
      match: (r: ProbeResult) => [400, 405, 415, 500].includes(r.status) || has(r.body, 'soap') || has(r.body, 'onvif'),
    })),
  },
  {
    kind: 'rtsp',
    get label() {
      return c().rtsp.label;
    },
    get blurb() {
      return c().rtsp.blurb;
    },
    category: 'camera',
    available: true,
    defaultPorts: [],
    get addressHint() {
      return c().rtsp.addressHint;
    },
    usesGateway: false,
    fields: [],
    fingerprints: [],
  },
  {
    kind: 'demo',
    get label() {
      return c().demo.label;
    },
    get blurb() {
      return c().demo.blurb;
    },
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
