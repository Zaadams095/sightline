/**
 * Camera systems (src/systems): the plain-language errors each brand adapter shows, default
 * names for unnamed cameras/presets/disks, Hub sharing text, and Demo mode's sample cameras.
 * Brand names (`label`, `brand`) are passed in untranslated.
 */
const systems = {
  // Names and short phrases any adapter can use
  common: {
    cameraN: (n: number | string) => `Camera ${n}`,
    camera: 'Camera',
    presetN: (n: number | string) => `Preset ${n}`,
    presetHome: 'Home',
    diskN: (n: number) => `Disk ${n}`,
    recordingDrive: 'Recording drive',
    cameraNotFound: 'Camera not found',
    noRecording: 'No recording at this time.',
    noRecordingThere: 'There’s no recording at this time.',
    noRecordingYet: 'There’s no recording at that time yet.',
    presetGone: 'That preset no longer exists on the camera.',
    cameraLacksThat: 'This camera doesn’t have that.',
    notSupported: (kind: string) => `${kind} is not supported yet`,
    needsFullApp: 'Live view for this camera needs the full app (not Expo Go).',
    notReachableHere: 'This camera isn’t reachable from this network.',
  },
  // Systems reached over HTTP; `label` is the brand ("Agent DVR", "Frigate"…)
  http: {
    stillConnecting: (label: string) => `Still connecting to ${label}. Try again in a moment.`,
    noAnswer: (label: string) => `${label} didn’t answer in time. Check that it’s on and reachable.`,
    cantReach: (label: string) => `Couldn’t reach ${label}. Check the address and that your phone is on the same network.`,
    unexpectedReply: (label: string) => `${label} sent an unexpected reply. Check that the address points to ${label}.`,
    unexpectedReplyShort: (label: string) => `${label} sent an unexpected reply.`,
    badLogin: (label: string) => `${label} didn’t accept the username or password. Check them and try again.`,
    badLoginShort: (label: string) => `${label} didn’t accept the username or password.`,
    forbidden: (label: string) => `This ${label} account isn’t allowed to do that. Ask the owner to give it more access.`,
    notFound: (label: string) => `${label} didn’t recognize the request. Check the address (including the port).`,
    unreachable: (label: string) => `Couldn’t reach ${label}. Check that it’s turned on and on the same network.`,
    serverProblem: (label: string, status: number) => `${label} had a problem (error ${status}). Try again in a moment.`,
    httpError: (label: string, status: number) => `${label} returned error ${status}.`,
    notThisSystem: (label: string, port: string) =>
      `That address answered, but it doesn’t look like ${label}. Check the address and port (usually ${port}).`,
    notThisSystemShort: (label: string) => `That address answered, but it doesn’t look like ${label}.`,
    couldntDo: (label: string, detail: string) => `${label} couldn’t do that (${detail}).`,
    said: (label: string, reason: string) => `${label} said: ${reason}`,
  },
  // A brand's own device ("the Reolink device", "the Hikvision device")
  device: {
    stillConnecting: (brand: string) => `Still connecting to the ${brand} device…`,
    cantReach: (brand: string) => `Couldn’t reach the ${brand} device. Check that it’s on and connected to your network.`,
    rejectedLogin: (brand: string) => `The ${brand} device rejected the username or password.`,
    notSupported: (brand: string) => `This ${brand} device doesn’t support that.`,
    couldntDo: (brand: string) => `The ${brand} device couldn’t do that.`,
    couldntDoDetail: (brand: string, detail: string) => `The ${brand} device couldn’t do that (${detail}).`,
    notThisBrand: (brand: string) => `This address doesn’t seem to be a ${brand} device. Check the address and try again.`,
    cameraNotFound: (brand: string) => `Camera not found on this ${brand} device.`,
  },
  reolink: {
    locked: 'The Reolink device has locked this account after too many wrong passwords. Wait a few minutes, then try again.',
    tooManySessions: 'Too many apps are signed in to the Reolink device. Close the Reolink app or web page on other devices, then try again.',
    signedOut: 'The Reolink device signed us out. Try again.',
    unexpectedReply: 'The Reolink device sent an unexpected reply.',
    unexpectedLogin: 'The Reolink device sent an unexpected sign-in reply.',
    httpsOnly: 'This Reolink device only accepts secure connections. Add it again using https:// before the address.',
    motionAreaNotKept: 'The camera didn’t keep the new motion area. Try again, or set it in the Reolink app.',
    zonesRefused: 'This camera didn’t let Sightline change its detection area. You can draw it in the Reolink app instead.',
    /** `list` is e.g. "motion, person and vehicle" (from `zoneKinds`). */
    zonesSaved: (list: string) => `Saved to the camera. It now only watches the highlighted area for ${list} detection.`,
    zonesCleared: (list: string) => `Saved to the camera. It watches the whole picture again for ${list} detection.`,
    zoneKinds: {
      motion: 'motion',
      person: 'person',
      vehicle: 'vehicle',
      animal: 'animal',
    } as Record<string, string>,
    rtspOff:
      'Live video is turned off on this Reolink device. In the Reolink app, open the device’s settings → Network → Advanced → Port Settings, and turn on RTSP.',
    vodPrepFailed: 'The Reolink recorder couldn’t prepare this recording for playback.',
    vodUnnamed: 'The Reolink device didn’t name this recording, so it can’t be played.',
  },
  hikvision: {
    locked: 'The Hikvision device has locked this account after too many wrong passwords. Wait about 30 minutes, then try again.',
    forbidden: 'This account isn’t allowed to do that. Sign in with the recorder’s admin account.',
    busy: 'The Hikvision device is busy. Try again in a moment.',
    reportedError: 'The Hikvision device reported an error. Try again in a moment.',
    cantMove: 'This camera can’t be moved.',
  },
  // Dahua / Amcrest / Lorex
  dahua: {
    noAnswer: 'The recorder didn’t answer in time. Check that it’s on and reachable.',
    cantReach: 'Couldn’t reach the recorder. Check the address and that your phone is on the same network.',
    locked: 'The recorder has locked this account after too many wrong passwords. Wait 30 minutes, or unlock it from the recorder’s screen.',
    badLogin:
      'The recorder didn’t accept that username and password. Check them and try again (they’re the ones you use on the recorder’s screen or in its app).',
    forbidden:
      'This user isn’t allowed to do that on the recorder. Sign in with the admin account, or give this user more permissions on the recorder.',
    notSupported: 'The recorder doesn’t support this feature.',
    unreachable: 'Couldn’t reach the recorder. Check that it’s turned on and connected to your network.',
    httpError: (status: number) => `The recorder answered with an error (HTTP ${status}). Try again in a moment.`,
    notDahua: 'This doesn’t look like a Dahua, Amcrest or Lorex device. Check the address.',
    searchFailed: 'The recorder couldn’t start a search. Try again in a moment.',
    cameraRefused: 'The camera didn’t accept that. Try again in a moment.',
  },
  frigate: {
    badLogin: 'Frigate rejected the login. Check your username and password.',
    forbidden: 'This Frigate user doesn’t have access to that.',
    semanticOff: 'Smart search needs Semantic Search turned on in Frigate (semantic_search: enabled: true).',
    searchFailed: 'Frigate couldn’t run that search. Try different words.',
    ptzFailed: 'Couldn’t connect to Frigate to move the camera. Check that it’s reachable, then try again.',
  },
  blueIris: {
    badLogin: 'Blue Iris didn’t accept the username or password. Check them in Blue Iris → Settings → Users.',
    refused: 'Blue Iris refused the request.',
    refusedLogin: 'Blue Iris refused the login. Try again.',
    sessionEnded: 'Blue Iris ended the session. Try again.',
    notBlueIris: 'That address answered, but it doesn’t look like the Blue Iris web server. Check the address and port (often 81).',
  },
  scrypted: {
    notALink: (text: string) =>
      `“${text}” isn’t a camera link. Paste the links that start with rtsp:// (from each camera’s Rebroadcast settings in Scrypted).`,
    noLinks: 'Paste at least one camera link. In Scrypted, open a camera → Rebroadcast → Streams and copy “RTSP Rebroadcast Url”.',
    linkRemoved: 'This camera’s link was removed. Edit the Scrypted system to add it again.',
  },
  shinobi: {
    needsKeys: 'Shinobi needs both an API key and a group key. Edit this system and add them.',
    badKeys:
      'Shinobi didn’t accept the API key and group key. Check both, and that the key’s “Allowed IPs” includes this phone’s address.',
    cameraNotFound: 'Camera not found in Shinobi.',
    streamType: (type: string) =>
      `This camera streams as “${type}”, which iPhone can’t play. In Shinobi, open the camera’s settings → Stream → Stream Type, choose HLS, and save.`,
    webm: 'This recording is saved as WebM, which iPhone can’t play. In Shinobi, set the camera’s Recording → Video Codec to copy or H.264 (MP4).',
  },
  zoneminder: {
    badLogin:
      'ZoneMinder didn’t accept the username or password. Also check that this user has “API” access turned on (Options → Users).',
    needsLogin: 'ZoneMinder needs a username and password. Edit this system and add them.',
    notFound:
      'Couldn’t find ZoneMinder at this address. Use the address you open ZoneMinder at, without the /zm part, and check that its API is turned on (Options → System → OPT_USE_API).',
  },
  onvif: {
    notConnected: 'Not connected to the camera yet.',
    noAnswer: 'The camera didn’t answer in time. Check that it’s on and that the phone is on the same network.',
    cantReach: 'Couldn’t reach the camera. Is the phone on the same network?',
    httpError: (status: number) => `The camera returned an error (HTTP ${status}).`,
    noStreams: 'The camera has no video streams set up. Check its video settings.',
    cameraGone: 'This camera is no longer available. Try removing and adding it again.',
    noVideoLink: 'The camera didn’t provide a video link.',
    cantPtz: 'This camera can’t pan or zoom.',
    presetMissing: (name: string) => `Preset “${name}” wasn’t found on the camera.`,
    badLogin:
      'Wrong username or password. Use the camera’s own login; some cameras need a separate ONVIF user, added in the camera’s settings.',
    notFound:
      'No ONVIF camera answered at this address. Turn on ONVIF in the camera’s settings, or add its ONVIF port to the address (often 8000, 2020 or 8899, e.g. 192.168.1.70:2020).',
    wrongLogin: 'Wrong username or password.',
    notSupported: 'The camera doesn’t support this feature.',
    refused: 'The camera refused the request.',
    refusedReason: (reason: string) => `The camera refused the request: ${reason}`,
  },
  unifi: {
    tooManyAttempts: 'Too many sign-in attempts. Wait a few minutes, then try again.',
    twoStep:
      'This account uses two-step verification. Create a local account on your UniFi console (UniFi OS → Admins & Users → add an admin with “Restrict to local access only”) and use that here.',
    badLogin:
      'Wrong username or password. Use a local UniFi account (one with “Restrict to local access only”), not your Ubiquiti cloud sign-in.',
    notConsole: 'This doesn’t look like a UniFi OS console. Enter the address of your Cloud Key, Dream Machine or NVR.',
    signedOut: 'UniFi Protect signed us out. Pull down to refresh; if it keeps happening, check the username and password.',
    forbidden:
      'This UniFi account isn’t allowed to do that. Give it the Protect “View only” role or higher (or Full Management for camera control).',
    notRunning: 'UniFi Protect isn’t running on this console, or that camera no longer exists.',
    unreachable: 'Couldn’t reach UniFi Protect. Check that the console is on and Protect has finished starting.',
    httpError: (status: number) => `UniFi Protect answered with an error (HTTP ${status}). Try again in a moment.`,
    noAnswer: 'UniFi Protect didn’t answer in time. Check that the console is on and reachable.',
    cantReach: 'Couldn’t reach the UniFi console. Check the address and that your phone is on the same network.',
    unexpectedReply: 'The UniFi console sent an unexpected reply. Check that the address points to your UniFi console.',
    cameraGone: 'That camera is no longer in UniFi Protect.',
    notInstalled: 'Signed in, but UniFi Protect isn’t installed or running on this console.',
    rtspOff:
      'Live video needs this camera’s RTSP stream turned on. In UniFi Protect, open the camera → Settings → Advanced and turn on an RTSP stream (any quality). Or sign in here with an admin account and Sightline turns it on for you.',
  },
  // Sightline Hub: errors, sharing roles and summaries
  hub: {
    theHub: 'the Hub',
    revoked: (hub: string) => `Your access to ${hub} was removed.`,
    expired: (hub: string) => `Your access to ${hub} has ended.`,
    unpaired: (hub: string) => `This phone isn't paired with ${hub} anymore. Remove it and pair again.`,
    httpError: (status: number) => `The Hub returned HTTP ${status}`,
    notAHub: 'That address isn’t a Sightline Hub.',
    notPaired: 'This phone isn’t paired with the Hub.',
    cantReachBoth: (home: string, away: string) => `Couldn’t reach the Hub at home (${home}) or away (${away}).`,
    cantReachAt: (address: string) =>
      `Couldn’t reach the Hub at ${address}. Away from home, the Hub needs remote access turned on (on its setup page).`,
    cantReachWifi: (address: string) => `Couldn’t reach the Hub at ${address}. Make sure this phone is on the same Wi-Fi as the Hub.`,
    cantReach: (detail: string) => `Couldn’t reach the Hub. ${detail}`.trim(),
    unsupportedPlayback: 'The Hub sent a recording this version of Sightline can’t play. Update the app.',
    owner: 'Owner',
    roles: {
      full: {
        label: 'Full access',
        description: 'Everything you can do, including sharing with others. For a partner, or your own other phone.',
      },
      household: {
        label: 'Household',
        description: 'Live view, recordings and alerts for the cameras you pick. For family who live with you.',
      },
      temporary: {
        label: 'Temporary',
        description: 'Live view and recordings for a set time, then it ends by itself. For a pet sitter or house sitter.',
      },
      live: {
        label: 'Live only',
        description: 'Just live video, no recordings. For a neighbor keeping an eye on things.',
      },
    } as Record<string, { label: string; description: string }>,
    /** Dates below are already formatted ("Oct 12", "Oct 12 6:30 PM"). */
    ends: (date: string) => `ends ${date}`,
    ended: (date: string) => `ended ${date}`,
    sharedBy: (hub: string) => `Shared by ${hub}`,
    sharedByEnds: (hub: string, ends: string) => `Shared by ${hub} · ${ends}`,
    allCameras: 'All cameras',
    noCameras: 'No cameras',
    twoCameras: (a: string, b: string) => `${a} & ${b}`,
    liveOnly: 'live only',
    recordingsRange: (from: string, to: string) => `recordings ${from} – ${to}`,
    inviteNotUsed: 'invite not used yet',
    notJoined: 'not joined',
    inviteLive: (hub: string) => `I'm sharing access so you can watch my cameras live (${hub}) in the Sightline app.`,
    inviteSee: (hub: string) => `I'm sharing access so you can see my cameras (${hub}) in the Sightline app.`,
    inviteWeb: (link: string) => `Open this on your iPhone: ${link}`,
    inviteApp: (link: string) => `If you already have Sightline: ${link}`,
  },
  // Demo mode's sample cameras (the names people see)
  demo: {
    systemName: 'Sample cameras',
    cameras: {
      'front-door': 'Front Door',
      driveway: 'Driveway',
      backyard: 'Backyard',
      garage: 'Garage',
      'living-room': 'Living Room',
    } as Record<string, string>,
    zones: {
      Porch: 'Porch',
      Walkway: 'Walkway',
      Driveway: 'Driveway',
      Street: 'Street',
      Lawn: 'Lawn',
      Patio: 'Patio',
      'Side door': 'Side door',
    } as Record<string, string>,
    familyCar: 'Family car',
    groups: {
      Outside: 'Outside',
      Inside: 'Inside',
    } as Record<string, string>,
    recordings: 'Recordings',
    presets: {
      'Whole view': 'Whole view',
      Driveway: 'Driveway',
      Street: 'Street',
      'Front lawn': 'Front lawn',
    } as Record<string, string>,
    sampleAlertBody: 'Sample alert. Your own cameras’ alerts look like this. Tap to watch the recording.',
  },
};

export default systems;
