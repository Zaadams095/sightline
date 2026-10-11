import { plural } from '../plural.ts';

const p = plural('en');

/** First-run setup, adding systems, joining a Hub, moving phones, Apple TV, and the system catalog. */
const onboarding = {
  // onboarding/index.tsx
  welcome: {
    addTitle: 'Add a recorder or camera',
    heroTitle: 'Your cameras.\nYour network.',
    intro: 'Watch live, look back at recordings and get alerts, straight from your own system. No Sightline account, and no Sightline cloud in between.',
    findCameras: 'Find my cameras',
    findCamerasDetail: 'Sightline looks around your home Wi-Fi and finds cameras and recorders for you.',
    pickBrand: 'Pick your camera brand',
    noCameras: 'No cameras handy?',
    noCamerasDetail: 'Explore every feature with built-in sample cameras. Nothing to set up, and you can connect your own any time.',
    trySample: 'Try it with sample cameras',
    sharedWithMe: 'Someone shared cameras with me',
    haveHub: 'I have a Sightline Hub',
    orChoose: 'Or choose what you record with',
    sections: {
      recorder: 'Recorders (the box your cameras plug into)',
      software: 'Camera software on a computer',
      camera: 'Individual cameras',
    } as Record<string, string>,
    comingSoon: 'Coming soon',
  },
  // onboarding/alerts.tsx
  alerts: {
    title: 'Alerts',
    intro: 'Choose how alerts reach you. You can pick which cameras and what kind of activity alert you any time in Settings.',
    builtIn: 'Built-in',
    noSetup: 'No setup',
    builtInBody:
      'Sightline checks your cameras in the background and sends notifications with a picture. iPhone decides when that runs, so alerts can be several minutes late.',
    instant: 'Instant Alerts',
    recommended: 'Recommended',
    needsHub: 'Needs a Sightline Hub',
    instantBody: 'Alerts arrive within a second, through your Sightline Hub. Pictures and video stay at home.',
    instantBodyNoHub:
      'Alerts within a second need a Sightline Hub at home: a free add-on for Home Assistant, or a small app for a NAS or always-on computer. Start with Built-in and switch any time.',
    setUpHub: 'Set up a Sightline Hub',
    finish: 'Finish',
  },
  // onboarding/brands.tsx
  brands: {
    subtitle: 'We’ll walk you through it, one step at a time.',
    search: 'Search',
    searchPlaceholder: 'Brand, app or model, e.g. Tapo',
    dontKnowA11y: 'I don’t know my brand. Help me find out.',
    dontKnow: 'I don’t know',
    helpMeFind: 'Help me find out',
    noMatch: 'No brand by that name yet. Try “I don’t know” above, or one of the options below.',
    notListed: 'Not listed?',
    otherCamera: 'Other network camera',
    otherCameraDetail: 'Most other cameras work with just their address and password',
    findOnWifi: 'Find cameras on my Wi-Fi',
    findOnWifiDetail: 'Sightline looks around and shows what it finds',
    haveStreamLink: 'I have a stream link',
    haveStreamLinkDetail: 'A link that starts with rtsp://',
    cloudOnly: 'Cloud only',
    appName: (app: string) => `${app} app`,
  },
  // onboarding/connect.tsx
  connect: {
    title: (name: string) => `Connect ${name}`,
    name: 'Name',
    nameOptional: 'Name (optional)',
    hubNamePlaceholder: 'Uses the Hub’s name',
    ifYouUseOne: (label: string) => `${label} (if you use one)`,
    couldntReach: (name: string) => `Couldn’t reach ${name}.`,
    tried: (message: string, url: string) => `${message} (tried ${url})`,
    badLogin: (name: string) => `${name} didn’t accept the username or password. Check them and try again.`,
    connected: (n: number) => p(n, { one: `Connected. Found ${n} camera.`, other: `Connected. Found ${n} cameras.` }),
    reachAway: 'Reach it when I’m away',
    reachAwayDetail: 'Uses your own VPN, if you set one up (Settings → Away from home). Not needed with a Sightline Hub.',
    checkStepByStep: 'Check the connection step by step',
    saveAnyway: 'Save anyway and set up away-from-home access',
    scanHubQr: 'Scan the Hub’s QR code instead',
    connect: 'Connect',
  },
  /** Shared by connect.tsx and invite.tsx. */
  connectedToHub: (hub: string, n: number) =>
    p(n, { one: `Connected to ${hub}. Found ${n} camera.`, other: `Connected to ${hub}. Found ${n} cameras.` }),
  // onboarding/discover.tsx
  discover: {
    title: 'Finding cameras',
    starting: 'Starting…',
    allowHint: 'If your phone asks to find devices on your local network, tap Allow.',
    nothingFound: 'Nothing found. Make sure you’re on your home Wi-Fi, or choose your brand on the previous screen.',
    cantConnectYet: 'Sightline can’t connect to this one yet.',
    unknownBrand: (address: string) => `${address} · Brand unknown. Tap to try with its password.`,
    lookAgain: 'Look again',
    chooseBrand: 'Choose my brand instead',
    /** Android 17+: local network access was turned off for Sightline. */
    localNetworkDenied: 'Sightline can’t reach devices on your Wi-Fi yet. In Settings, open Permissions › Nearby devices and choose Allow.',
    openSettings: 'Open Settings',
  },
  // systems/discovery.ts
  discovery: {
    checking: (n: number) => p(n, { one: `Checking ${n} device…`, other: `Checking ${n} devices…` }),
    lookingAround: (network: string) => `Looking around ${network}…`,
    needsFullApp: 'Finding cameras needs the full app (not Expo Go).',
    connectWifi: 'Connect to your home Wi-Fi first.',
    camera: 'Camera',
  },
  // onboarding/find-brand.tsx
  findBrand: {
    title: 'Let’s find out together',
    subtitle: 'Any one of these will do.',
    letLook: 'Let Sightline look',
    letLookBody: 'It checks your home Wi-Fi for cameras and recorders. Takes about 20 seconds.',
    sticker: 'Check the sticker',
    stickerStep1: 'Most cameras have a sticker underneath, on the back, or inside the battery door. Recorders have one on the bottom.',
    stickerStep2: 'It shows the brand and model, and often a code or password you may need later.',
    stickerStep3: 'Take a photo of it with your phone’s Camera app so the codes are handy when you need them.',
    noSticker: 'No sticker? The brand is usually printed on the front of the camera or on its box.',
    whichApp: 'Which app do you watch it with?',
    whichAppBody: 'The app on your phone tells you the brand. Tap yours.',
    backToBrands: 'Back to brands',
  },
  // onboarding/invite.tsx
  invite: {
    cameraNeeded: 'Camera access is needed to scan the code. You can type the code instead.',
    guestJoined: (hub: string, n: number) =>
      p(n, { one: `You’re in. ${hub} shared ${n} camera with you.`, other: `You’re in. ${hub} shared ${n} cameras with you.` }),
    allSet: 'All set',
    seeCameras: 'See cameras',
    titlePair: 'Connect to your Hub',
    titleShared: 'Shared cameras',
    pairWith: (name: string) => `Pair this phone with ${name}.`,
    yourHub: 'your Sightline Hub',
    sharedBy: (name: string) => `${name} shared cameras with you. Tap Join to start watching.`,
    someone: 'Someone',
    scanIntro: 'Scan the QR code someone shared with you, or the code on your Sightline Hub’s setup page.',
    pairingCode: (code: string) => `Pairing code ${code}`,
    inviteCode: (code: string) => `Invite code ${code}`,
    join: 'Join',
    scanDifferent: 'Scan a different code',
    scanQr: 'Scan QR code',
    typeCode: 'Type a code instead',
    hubAddress: 'Hub address',
    hubAddressPlaceholder: '192.168.1.20:8086 or https://….ts.net',
    hubAddressHint: 'From the invite message, or the Hub’s setup page.',
    code: 'Code',
    codePlaceholder: 'ABCDE-FGHJK or 6 digits',
    notSightlineCode: 'That QR code isn’t a Sightline code. Scan the code on the Hub’s setup page or in the invite.',
    pointCamera: 'Point the camera at the Sightline QR code',
  },
  // onboarding/lock.tsx
  lock: {
    prompt: 'Lock Sightline',
    didntWork: (method: string) => `${method} didn’t work. Try again, or tap Not now.`,
    title: 'Keep your cameras private',
    body: (method: string) => `Use ${method} to open Sightline, so anyone borrowing your phone can’t look at your cameras. No account or password to remember.`,
    turnOn: (method: string) => `Turn on ${method}`,
    changeLater: 'You can change this any time in Settings → Privacy & lock.',
  },
  // onboarding/move.tsx
  move: {
    cameraNeeded: 'Camera access is needed to scan the code. You can use a backup file instead.',
    allSet: 'You’re all set',
    setUpOne: 'Your recorder is set up.',
    setUpOneFrom: (phone: string) => `Your recorder is set up, just like on ${phone}.`,
    setUpMany: (n: number) => `Your ${n} recorders and cameras are set up.`,
    setUpManyFrom: (n: number, phone: string) => `Your ${n} recorders and cameras are set up, just like on ${phone}.`,
    seeMyCameras: 'See my cameras',
    title: 'Moving from another phone?',
    intro: 'Bring your cameras, passwords and settings over in a minute. Nothing needs typing again.',
    oldPhoneNearby: 'With your old phone nearby',
    oldPhoneBody:
      'On the old phone, open Sightline, then Settings → Backup & new phone → Transfer to another phone. Keep both phones on the same home Wi-Fi, then scan the code it shows.',
    scanCode: 'Scan the code',
    withBackup: 'With a backup file',
    withBackupBody: 'If you saved a Sightline backup file (AirDrop, Files or iCloud Drive), open it here and type the passcode you chose.',
    passcode: 'Passcode',
    passcodePlaceholder: 'The passcode you chose',
    restore: 'Restore',
    differentFile: 'Choose a different file',
    openBackup: 'Open a backup file',
    pointOldPhone: 'Point the camera at the code on your old phone',
  },
  // onboarding/rtsp.tsx
  rtsp: {
    notLink: 'That doesn’t look like a stream link. It should start with rtsp://',
    previewOnly: 'Testing works in the full app, not the preview.',
    theCamera: 'the camera',
    answered: 'The camera answered. If the picture doesn’t show, check the link’s username, password and path.',
    defaultCamera: 'Camera',
    systemName: 'IP cameras',
    title: 'Add a camera by stream link',
    intro: 'Cameras added this way show live video only. To look back at recordings, add the recorder or camera software they record to instead.',
    namePlaceholder: 'Driveway',
    streamLink: 'Stream link',
    streamHint:
      'A video link that starts with rtsp:// (often called an RTSP link). Find it in the camera’s manual or its app, usually under Network or Streaming.',
    testLink: 'Test link',
    pictureLink: 'Picture link (optional)',
    pictureHint: 'A still-picture link from the camera’s manual. Makes the camera grid load faster.',
    reachAwayDetail: 'Uses your own VPN, if you set one up (Settings → Away from home).',
    addCamera: 'Add camera',
  },
  // onboarding/vpn.tsx
  vpn: {
    awayTitle: 'Away from home',
    hubHandles: 'Your Sightline Hub takes care of this. Your cameras will work anywhere.',
    title: 'Watching when you’re away',
    intro: 'At home, Sightline connects directly. To see your cameras from anywhere else, pick one:',
    hubOption: 'Sightline Hub (easiest)',
    hubBody:
      'A free add-on for Home Assistant, or a small app for a NAS or always-on computer. No router settings. Also gives instant alerts and sharing with family.',
    vpnOption: 'My own VPN (advanced)',
    vpnBody: 'If your router already has a VPN you connect to from your phone, scan its QR code. Sightline turns it on by itself only when needed.',
    hubSteps: 'Install the Hub, open its setup page, then scan the QR code it shows. You can do this any time from Settings.',
    haveHub: 'I have the Hub running: scan its code',
    previewOnly: 'Preview mode: your own VPN only works in the full app.',
    homeOnly: 'Only at home for now',
    changeLater: 'You can change this later in Settings.',
  },
  // app/tv.tsx
  tv: {
    title: 'Connect Apple TV',
    tvAnswered: (status: number) => `The TV answered HTTP ${status}.`,
    cantReachTv:
      'Couldn’t reach the TV. Make sure this iPhone is on the same Wi-Fi as the Apple TV, and that the Sightline code is still on the TV screen.',
    notTvCode: 'That isn’t a Sightline TV code. Open Sightline on the Apple TV and scan the code it shows.',
    connected: 'Your Apple TV is connected',
    connectedBody: (name: string) => `It shows the cameras on your Hub. To remove it later, open Settings → Sharing and remove “${name}”.`,
    needsHub: 'Apple TV needs a Sightline Hub',
    needsHubBody:
      'The TV app shows cameras through your Sightline Hub, so it works with every brand. Set up a Hub (Settings → Instant Alerts or Sharing), then scan the TV code again.',
    showOn: (name: string) => `Show your cameras on “${name}”?`,
    grantBody: 'The TV gets live view and snapshots of all cameras, nothing else. You can remove it anytime in Sharing.',
    whichHub: 'Which Hub',
    selected: 'Selected',
    connectTv: 'Connect TV',
  },
  /** systems/hub-join.ts and app/tv.tsx */
  cantReachHub: 'Couldn’t reach the Hub.',
  // systems/catalog.ts: brand names stay as they are; descriptions and setup fields are translated.
  catalog: {
    address: 'Address',
    username: 'Username',
    password: 'Password',
    hub: {
      blurb: 'Instant alerts, sharing and remote access for any system',
      addressHint: 'Shown on the Hub’s setup page. Easiest: scan its QR code.',
      addressHelp: 'Or scan the QR code on the Hub setup page.',
      code: 'Pairing code',
      codePlaceholder: '6 digits',
      codeHint: 'Shown on the Hub’s setup page.',
    },
    frigate: {
      blurb: 'AI-powered recorder for any camera',
      addressHint: 'The address you open Frigate at in a browser, e.g. 192.168.1.10:8971.',
      addressHelp: 'Port is optional; Sightline finds it.',
    },
    reolink: {
      blurb: 'Reolink recorders, Home Hub and cameras',
      addressHint:
        'In the Reolink app, open the device’s settings and look for Network Information (or Device Info) to see its IP address. Use the recorder or Home Hub address if you have one.',
      addressHelp: 'The recorder, Home Hub or single camera address.',
      passwordHint: 'The password you use in the Reolink app for this device.',
    },
    hikvision: {
      blurb: 'Hikvision recorders and cameras (also many rebranded ones)',
      addressHint:
        'On the recorder’s screen: Menu → Configuration → Network → General shows the IPv4 address. For a single camera, look for it in your router’s list of connected devices.',
      addressHelp: 'The recorder (or camera) address.',
      passwordHint: 'The password you sign in to the recorder with (not your Hik-Connect account).',
    },
    dahua: {
      blurb: 'Dahua, Amcrest and Lorex recorders and cameras',
      addressHint:
        'On the recorder’s screen: Main Menu → Network shows the IP address. In the Amcrest or Lorex app, open the device’s settings → Device info.',
      addressHelp: 'The recorder’s address (or a single camera’s).',
      usernameHint: 'The same sign-in you use on the recorder’s screen or in its app.',
    },
    unifi: {
      blurb: 'UniFi cameras on a Cloud Key, Dream Machine or UniFi recorder',
      addressHint:
        'Your UniFi console’s address (often 192.168.1.1). Sign in with a local account: in UniFi OS open Admins & Users → add an admin, choose “Restrict to local access only”, and give it access to Protect.',
      addressHelp: 'The address of your Cloud Key, Dream Machine or UniFi recorder.',
      usernameHint: 'A local UniFi account, not your Ubiquiti cloud email.',
    },
    blueIris: {
      blurb: 'Windows camera software',
      addressHint:
        'On the Blue Iris computer: Settings → Web server shows the local address (often port 81). Sign in with a Blue Iris user from Settings → Users.',
      addressHelp: 'Port is optional; Sightline tries 81 first.',
      usernameHint: 'A Blue Iris user (Settings → Users). Leave empty if Blue Iris allows anonymous viewing.',
    },
    scrypted: {
      blurb: 'Home video software (live view, added camera by camera)',
      addressHint:
        'The address you open Scrypted at (port 10443). Then, for each camera in Scrypted: open the camera → Rebroadcast → Streams, copy “RTSP Rebroadcast Url” and paste it below.',
      addressHelp: 'Used to fill in “localhost” in the links.',
      links: 'Camera links',
      linksPlaceholder: 'Porch=rtsp://localhost:34567/a1b2…',
      linksHint:
        'Paste each camera’s “RTSP Rebroadcast Url”, separated by spaces. To name a camera, put its name and = in front, like Porch=rtsp://….',
      usernameHint: 'Optional: your Scrypted sign-in, to check the address.',
    },
    zoneminder: {
      blurb: 'Open-source camera software',
      addressHint: 'The address you open ZoneMinder at, without “/zm” (e.g. 192.168.1.50). The user needs API access (Options → Users).',
      addressHelp: 'Leave off /zm; Sightline finds it.',
      usernameHint: 'Leave empty if ZoneMinder doesn’t ask you to sign in.',
    },
    shinobi: {
      blurb: 'Open-source camera software',
      addressHint: 'The address you open Shinobi at (port 8080). Sightline signs in with an API key instead of your password.',
      addressHelp: 'Port is optional; Sightline tries 8080 first.',
      apiKey: 'API key',
      apiKeyPlaceholder: 'Paste the API key',
      apiKeyHint:
        'In Shinobi, open the menu (your name, top left) → API Keys. Tick the permissions. Under Allowed IPs, enter this phone’s address (iPhone Settings → Wi-Fi → tap ⓘ next to your network → IP Address). Tap Add, then copy the key.',
      groupKey: 'Group key',
      groupKeyPlaceholder: 'e.g. aBcD1234',
      groupKeyHint: 'In Shinobi, open the menu → Account Settings. The group key is shown at the top.',
    },
    agentDvr: {
      blurb: 'Camera software by iSpy',
      addressHint: 'The address you open Agent DVR at (port 8090). For recordings to play on iPhone, set each camera’s recording format to MP4.',
      addressHelp: 'Port is optional; Sightline tries 8090 first.',
      usernameHint: 'Only if “Protect API” is turned on in Agent’s server settings.',
    },
    onvif: {
      label: 'Other network camera',
      blurb: 'Most Wi-Fi and wired cameras: just the address and password',
      addressHint:
        'The camera’s address from your router’s device list or the camera’s app. Sign in with the same login you use in the camera’s app or web page.',
      addressHelp:
        'Just the address is usually enough. If it doesn’t connect, turn on “ONVIF” (the standard way apps talk to cameras) in the camera’s app, and add the port it shows, e.g. 192.168.1.70:8000.',
      usernameHint: 'Often “admin”. Some cameras need a separate camera account, made in their app.',
      passwordHint: 'The camera’s password (not your Wi-Fi password).',
    },
    rtsp: {
      label: 'Camera by stream link',
      blurb: 'Paste a video link from the camera’s manual (advanced)',
      addressHint: 'The video link (starts with rtsp://) from the camera’s manual, e.g. rtsp://user:pass@192.168.1.50:554/stream1.',
    },
    demo: {
      label: 'Sample cameras',
      blurb: 'Built-in sample video to explore the app',
    },
  },
};

export default onboarding;
