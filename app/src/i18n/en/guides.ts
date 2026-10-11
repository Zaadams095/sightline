import { plural } from '../plural.ts';

const p = plural('en');

/**
 * Brand setup guides (systems/guides.ts), their shared parts (components/guide/parts.tsx) and
 * the guide screen (app/onboarding/guide.tsx).
 *
 * Menu names inside a brand's own app or web page ("Advanced Settings → Camera Account") stay
 * as the brand writes them in English in every language, so people can match what they see;
 * only the sentence around them is translated. Sticker words ("Safety code") stay English too.
 */
const guides = {
  // ---- systems/guides.ts ----
  /** Last step of every guide that continues in Sightline ("Next" is the button below). */
  comeBack: 'Come back here and tap Next.',
  badAddress: 'That doesn’t look like a camera address. It should look like 192.168.1.50.',
  alt: {
    pickAnother: 'Pick a different brand',
    findOnWifi: 'Find cameras on my Wi-Fi',
    haveLink: 'I have a stream link (rtsp://…)',
    seeWorking: 'See cameras that work with Sightline',
  },
  groups: {
    camera: 'Wi-Fi cameras',
    recorder: 'Cameras with a recorder, and pro brands',
    cloud: 'Cloud-only cameras',
  },
  /** Brand app names that need a word between them. */
  apps: {
    amcrest: 'Amcrest Smart Home or Amcrest View Pro',
    lorex: 'Lorex Home or Lorex Cloud',
  },
  tapo: {
    plugin: {
      title: 'Plugged-in camera',
      detail: 'Most Tapo cameras with a power cord',
      steps: [
        'Open the Tapo app and tap your camera.',
        'Tap the gear at the top right, then Advanced Settings → Camera Account.',
        'Tap “Understand and Agree to Use”. Make a username and a password (6 to 32 characters each) and write them down. This is just for the camera, not your Tapo login.',
      ],
      usernameLabel: 'Camera account username',
      usernameHint: 'The username you just made in the Tapo app.',
      passwordLabel: 'Camera account password',
      passwordHint: 'Not your Tapo login password.',
      cameraName: 'Tapo camera',
    },
    battery: {
      title: 'Battery camera or doorbell',
      detail: 'Like the C400, C420, C425 or a battery doorbell',
      why: 'Tapo battery cameras sleep between recordings to save power, so they only send video to the Tapo app. Sightline can’t show them, but it works with Tapo cameras that plug into the wall.',
      usePlugin: 'Set up a plugged-in Tapo camera',
    },
  },
  wyze: {
    v3: {
      title: 'Wyze Cam v3 or Pan v3',
      detail: 'With the camera’s latest update',
      steps: [
        'Update the Wyze app, then update the camera (camera settings → Device Info → Firmware).',
        'In the camera’s settings, tap Advanced Settings → RTSP and turn it on.',
        'Make a username and password (4 to 10 letters or numbers), then tap Generate URL.',
        'Tap Copy to copy the link it shows.',
      ],
      usernameLabel: 'RTSP username',
      usernameHint: 'The username you just made in the Wyze app.',
      passwordLabel: 'RTSP password',
      cameraName: 'Wyze camera',
    },
    other: {
      title: 'Wyze Cam v4, OG, doorbell or battery camera',
      why: 'These Wyze cameras only send video to the Wyze app for now. Wyze has said a stream option is coming for the Cam v4, but it isn’t out yet. If it arrives, come back and pick “Wyze Cam v3 or Pan v3”, the steps are the same.',
    },
  },
  eufy: {
    rtsp: {
      title: 'Camera with “NAS (RTSP)”',
      detail: 'Most plugged-in eufy cameras',
      steps: [
        'Open the eufy Security app and tap your camera, then the gear for its settings.',
        'Look for Storage → NAS (RTSP) and turn it on. If you don’t see it, this camera can’t share video (see “Other eufy cameras”).',
        'Choose “Continuous” so video is always there, set a username and password, and copy the link it shows.',
      ],
      usernameLabel: 'RTSP username',
      usernameHint: 'The username from the NAS (RTSP) screen in the eufy app.',
      passwordLabel: 'RTSP password',
      cameraName: 'eufy camera',
    },
    other: {
      title: 'Other eufy cameras',
      detail: 'No “NAS (RTSP)” in the app',
      why: 'Some eufy cameras, mostly battery ones, only send video to the eufy app. If the app has no “NAS (RTSP)” setting for the camera, Sightline can’t show it.',
      checkAgain: 'Check again for “NAS (RTSP)”',
    },
  },
  imou: {
    camera: {
      title: 'Imou camera',
      detail: 'Most plugged-in models',
      steps: [
        'Find the sticker on the camera (often underneath). Look for “Safety code” or “SC”, a short code of letters and numbers.',
        'Take a photo of it, or write it down exactly. Capital letters matter.',
      ],
      usernameHint: 'Imou cameras use “admin”.',
      passwordLabel: 'Safety code',
      passwordHint: 'The code from the sticker, even if you changed the password in the Imou app.',
      cameraName: 'Imou camera',
    },
  },
  ezviz: {
    camera: {
      title: 'EZVIZ camera',
      detail: 'Many plugged-in models',
      steps: [
        'Find the sticker on the camera and note the 6-letter “Verification code”. Capital letters matter.',
        'In the EZVIZ app, tap your profile → Settings → LAN Live View → Start Scanning, and pick your camera.',
        'Tap the gear → Local Server Settings, and turn on RTSP. If there’s no RTSP switch, this camera can’t share video.',
      ],
      usernameHint: 'EZVIZ cameras use “admin”.',
      passwordLabel: 'Verification code',
      passwordHint: 'The code from the camera’s sticker.',
      cameraName: 'EZVIZ camera',
    },
  },
  kasa: {
    all: {
      title: 'Kasa camera',
      why: 'Kasa cameras only send video to the Kasa app, so Sightline can’t show them. TP-Link’s Tapo cameras (same company) do work with Sightline.',
      useTapo: 'Set up a Tapo camera',
    },
  },
  reolink: {
    wired: {
      title: 'Plugged-in camera, recorder or Home Hub',
      detail: 'Anything with a power cord, a recorder box, or a Home Hub',
      steps: [
        'Have your Reolink password ready (the one for the camera or recorder in the Reolink app).',
        'If you have a recorder or Home Hub, use it: every camera on it shows up in Sightline, battery ones too.',
      ],
    },
    battery: {
      title: 'Battery camera on its own',
      detail: 'Argus, Altas, battery doorbell, without a Home Hub',
      why: 'Reolink battery cameras sleep to save power, so on their own they only talk to the Reolink app. Connected to a Reolink Home Hub or recorder, they work in Sightline.',
      haveHub: 'I have a Home Hub or recorder',
    },
    lte: {
      title: '4G / LTE camera (with a SIM card)',
      why: 'Reolink’s 4G cameras use the mobile network instead of your home Wi-Fi, so only the Reolink app can reach them.',
    },
  },
  amcrest: {
    all: {
      title: 'Amcrest camera or recorder',
      steps: [
        'Have the camera’s (or recorder’s) admin password ready, the one you made when you first set it up.',
        'If your cameras are on a recorder, use the recorder’s address: all its cameras show up at once.',
      ],
    },
  },
  lorex: {
    recorder: {
      title: 'Recorder (a box your cameras plug into)',
      detail: 'Most Lorex NVR and DVR kits',
      steps: [
        'On the recorder’s screen, open Main Menu → Network to see its IP address, or check Device info in the Lorex app.',
        'Have the recorder’s admin password ready (the one you use on the recorder’s screen).',
      ],
    },
    wifi: {
      title: 'Wi-Fi or battery camera with no recorder',
      detail: 'Set up only in the Lorex Home app',
      why: 'Most Lorex Wi-Fi and battery cameras without a recorder only send video to the Lorex app. If yours is connected to a Lorex recorder, add the recorder instead and it will show up.',
      onRecorder: 'It’s on a Lorex recorder',
    },
  },
  swann: {
    recorder: {
      title: 'Recorder (a box your cameras plug into)',
      detail: 'Most Swann NVR and DVR kits',
      steps: [
        'On the recorder’s screen, open the menu → Network to see its IP address.',
        'Have the recorder’s admin password ready (the one you use on the recorder’s screen).',
      ],
    },
    wifi: {
      title: 'Wi-Fi or battery camera with no recorder',
      why: 'Swann’s Wi-Fi and battery cameras only send video to the Swann Security app, so Sightline can’t show them.',
      haveRecorder: 'I have a Swann recorder',
    },
  },
  annke: {
    all: {
      title: 'Annke camera or recorder',
      steps: [
        'Have the admin password ready, the one you made when you first set up the camera or recorder.',
        'If your cameras are on a recorder, use the recorder: all its cameras show up at once.',
      ],
    },
  },
  hikvision: {
    all: {
      title: 'Hikvision camera or recorder',
      detail: 'Also HiWatch, LTS and other Hikvision-made brands',
      steps: ['Have the admin password ready, the one you sign in to the recorder with (not your Hik-Connect account).'],
    },
  },
  dahua: {
    all: {
      title: 'Dahua camera or recorder',
      steps: ['Have the admin password ready, the one you use on the recorder’s screen.'],
    },
  },
  ubiquiti: {
    all: {
      steps: [
        'On a computer, open your UniFi console and go to Admins & Users → add a new admin.',
        'Choose “Restrict to local access only”, give it access to Protect, and set a username and password.',
      ],
    },
  },
  /** Why each cloud-only brand can't join. */
  cloudWhy: {
    ring: 'Ring cameras send video only to Ring’s cloud, and Ring doesn’t let other apps watch them. That’s Ring’s choice, not something wrong with your camera. Keep using the Ring app for these.',
    nest: 'Nest cameras send video only to Google’s cloud. Google doesn’t offer a way for apps like Sightline to show them on your home network. Keep using the Google Home app for these.',
    arlo: 'Arlo cameras send video only to Arlo’s cloud, so Sightline can’t show them. Keep using the Arlo app for these.',
    blink: 'Blink cameras send video only to Blink’s cloud, so Sightline can’t show them. Keep using the Blink app for these.',
    simplisafe:
      'SimpliSafe cameras are part of SimpliSafe’s own system and don’t share video with other apps. Keep using the SimpliSafe app for these.',
  },

  // ---- components/guide/parts.tsx ----
  parts: {
    stepOf: (step: number, total: number, label: string) => `Step ${step} of ${total} · ${label}`,
    stepOfA11y: (step: number, total: number, label: string) => `Step ${step} of ${total}: ${label}`,
    /** ChoiceRow's spoken label: "Plugged-in camera. Most Tapo cameras with a power cord" */
    titleDetail: (title: string, detail: string) => `${title}. ${detail}`,
    starting: 'Starting…',
    findIt: 'Find it on my Wi-Fi',
    looking: 'Looking for it…',
    /** `status` is the scanner's own progress line. "Allow" is the button on iOS's prompt. */
    lookingDetail: (status: string) => `${status} If your phone asks to find devices on your network, tap Allow.`,
    notFound: 'Didn’t spot it. Make sure the camera is on and your phone is on the same Wi-Fi, or type its address below.',
    found: (n: number) => p(n, { one: 'Found one. Is this it?', other: `Found ${n}. Tap the one you’re setting up.` }),
    lookAgain: 'Look again',
  },

  // ---- app/onboarding/guide.tsx ----
  screen: {
    missingTitle: 'Let’s try another way',
    missingBody: 'That brand guide isn’t available. Pick your brand again, or let Sightline look for your cameras.',
    pickBrand: 'Pick my brand',
    findOnWifi: 'Find cameras on my Wi-Fi',
    stageWhich: 'Which camera',
    stageReady: 'Get ready',
    stageConnect: 'Connect',
    whichOne: (brand: string) => `Which ${brand} do you have?`,
    notSure: 'Not sure? Look at the camera: if it has a power cord, it’s plugged in.',
    differentOne: 'I have a different one',
    stepsAgain: 'Show the steps again',
  },
  unsupported: {
    title: 'This one can’t join Sightline',
    nothingWrong: 'Nothing is wrong with your camera, and your other cameras can still live here.',
    whatYouCanDo: 'What you can do',
  },
  system: {
    where: (brand: string) => `Where is your ${brand}?`,
    body: 'Sightline can look for it on your home Wi-Fi, so you don’t have to type its address.',
    typeAddress: 'I’ll type the address',
  },
  connect: {
    title: (camera: string) => `Connect your ${camera}`,
    body: 'Just the camera’s address and the account you made. Sightline does the rest.',
    noLink: (app: string) => `There’s no link copied yet. In the ${app} app, tap Copy next to the link, then try again.`,
    /** Name of the group Sightline files stream cameras under. */
    ipCameras: 'IP cameras',
    /** Fills the blank in network error messages ("Couldn’t find the camera on this network…"). */
    theCamera: 'the camera',
    badAddress: 'That address doesn’t look right. It should look like 192.168.1.50.',
    copiedFrom: (app: string) => `Copied the link from the ${app} app?`,
    paste: 'Paste the link',
    pastedWithAccount: 'Link pasted. It already has the username and password in it.',
    pastedNoAccount: 'Link pasted. Add the username and password below.',
    address: 'Camera address',
    addressHint: (app: string) => `Or find it in the ${app} app: camera settings → Device info (or Network). It looks like 192.168.1.50.`,
    username: 'Username',
    password: 'Password',
    name: 'Name',
    namePlaceholder: 'Front door',
    away: 'Reach it when I’m away',
    awayDetail: 'Uses your own VPN, if you set one up (Settings → Away from home).',
    showLink: 'Show the link Sightline will use',
    addAnyway: 'Add it anyway',
    connect: 'Connect',
  },
};

export default guides;
