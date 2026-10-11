import { plural } from '../plural.ts';

const p = plural('en');

/** English plurals for what cameras see ("cars", "people"). */
const MANY: Record<string, string> = { person: 'people', bus: 'buses', mouse: 'mice', face: 'faces', license_plate: 'license plates' };

/** Notifications and the text alert code builds (alerts/*, check-ins, zones, connection errors). */
const alerts = {
  // Camera alerts (rules.ts, background.ts, live-activity*.ts)
  ringHeadline: "Someone's at the door",
  activity: 'Activity',
  /** Notification body after the time: " in Driveway, Porch". */
  inZones: (zones: string) => ` in ${zones}`,
  snoozeHour: 'Snooze this camera for 1 hour',
  snoozeMorning: 'Snooze this camera until 7 AM',
  watch: 'Watch',
  // Android notification channels: names in Settings › Apps › Sightline › Notifications (channels.ts)
  channels: {
    alerts: 'Camera alerts',
    alertsAbout: 'People, cars, animals and motion your cameras see.',
    doorbell: 'Doorbell',
    doorbellAbout: 'Someone is at the door.',
    packages: 'Packages',
    packagesAbout: 'Deliveries, and packages still waiting outside.',
    checkins: 'Family check-ins',
    checkinsAbout: 'When someone you look out for hasn’t been seen yet.',
    health: 'Camera problems',
    healthAbout: 'A camera is offline or a recorder is almost full.',
  },
  // Health alerts (background.ts)
  health: {
    offline: (camera: string) => `${camera} is offline`,
    offlineBody: (system: string) => `No video from this camera on ${system}.`,
    storageFull: (system: string, pct: number) => `${system} storage is ${pct}% full`,
    storageBody: (gb: number) => `${gb} GB left. Older video will be replaced sooner than usual.`,
    notResponding: (system: string) => `${system} isn't responding`,
  },
  // Packages (packages.ts, packages-notify.ts)
  packages: {
    gotIt: 'I got it',
    delivered: (camera: string) => `Package delivered · ${camera}`,
    arrivedAt: (time: string) => `Arrived at ${time}.`,
    pickedUp: (camera: string) => `Package may have been picked up · ${camera}`,
    pickedUpBody: 'Someone came by after it was delivered, and it hasn’t been seen since.',
    stillAt: (where: string) => `A package is still at ${where}`,
    stillOutside: (n: number) => p(n, { one: `${n} package is still outside`, other: `${n} packages are still outside` }),
    reminderBody: 'It was delivered earlier and hasn’t been picked up.',
    at: (where: string) => `At ${where}.`,
  },
  // "Fewer false alarms that learn" (smart.ts, learning.ts)
  learned: {
    notImportant: 'Not important',
    alwaysTell: 'Always tell me about this',
    undo: 'Undo',
    stopAlerting: 'Stop alerting for these',
    keepAlerting: 'Keep alerting',
    askTitle: 'Stop alerting for these?',
    learnedTitle: 'Sightline learned something',
    /** One kind of thing, counted: "car" / "cars". `o` is the system's label ("license_plate"). */
    thing: (o: string, n: number) => {
      const pretty = o.replace(/_/g, ' ');
      return n === 1 ? pretty : (MANY[o] ?? `${pretty}s`);
    },
    motionAlerts: (n: number) => p(n, { one: 'motion alert', other: 'motion alerts' }),
    /** Several things together: "car & person alerts". */
    comboAlerts: (things: string, n: number) => p(n, { one: `${things} alert`, other: `${things} alerts` }),
    atNight: ' at night',
    duringDay: ' during the day',
    inZones: (zones: string) => ` in ${zones}`,
    or: 'or',
    /** "Cars on Driveway at night". */
    title: (what: string, camera: string, extra: string) => `${what} on ${camera}${extra}`,
    always: (what: string, camera: string) => `You asked to always hear about ${what} on ${camera}. They won’t be quieted.`,
    /** "5 cars on Driveway at night". */
    counted: (n: number, what: string, camera: string, extra: string) => `${n} ${what} on ${camera}${extra}`,
    askPeople: (what: string) => `You marked ${what} as not important. Sightline never quiets people on its own — stop alerting for these?`,
    willStop: (what: string) => `You marked ${what} as not important — Sightline will stop alerting for those.`,
  },
  // Family check-ins (checkins.ts, checkins-run.ts, clock.ts)
  checkins: {
    /** The place, as it goes after "at": "Mom’s". */
    placeOf: (who: string) => (/s$/i.test(who) ? `${who}’` : `${who}’s`),
    /** A place without a person ("Cabin"). */
    placeNamed: (place: string) => place,
    home: 'home',
    fine: (who: string) => `${who}’s fine`,
    allFine: 'All fine',
    theCameras: 'the cameras',
    or: 'or',
    camera: 'camera',
    lastActive: (camera: string, when: string) => `${camera} was last active ${when}.`,
    notSeen: (cameras: string) => `Sightline hasn’t seen anyone on ${cameras} since it started watching.`,
    noActivityYet: (place: string) => `No activity at ${place} yet today`,
    itsNow: (time: string, last: string) => `It’s ${time}. ${last}`,
    noActivityFor: (place: string, h: number) => p(h, { one: `No activity at ${place} for ${h} hour`, other: `No activity at ${place} for ${h} hours` }),
    allNormal: (place: string) => `All normal at ${place}`,
    summaryBody: (time: string, n: number) => p(n, { one: `First activity ${time} · ${n} moment today.`, other: `First activity ${time} · ${n} moments today.` }),
    noActivityToday: (place: string) => `No activity at ${place} today`,
    notCheckedYet: 'Not checked yet.',
    status: (time: string, n: number) => p(n, { one: `First activity today ${time} · ${n} moment.`, other: `First activity today ${time} · ${n} moments.` }),
    noActivityYetToday: (last: string) => `No activity yet today. ${last}`,
    watchCamera: (camera: string) => `Watch ${camera}`,
    call: (who: string) => `Call ${who}`,
    unconfirmedTitle: (place: string) => `Couldn’t confirm activity at ${place} yet`,
    unconfirmedBody: (place: string, time: string) =>
      `Sightline couldn’t reach the cameras at ${place} to check by ${time}. Tap to look. Without a Sightline Hub, check-ins can be late.`,
    // "today at 9:15 AM" / "on Monday at 9:15 PM" (clock.ts)
    today: (time: string) => `today at ${time}`,
    yesterday: (time: string) => `yesterday at ${time}`,
    onDay: (day: string, time: string) => `on ${day} at ${time}`,
    onDate: (month: string, day: number, time: string) => `on ${month} ${day} at ${time}`,
    dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  // Activity zones (zones.ts)
  zones: {
    objects: { person: 'People', vehicle: 'Vehicles', animal: 'Animals', package: 'Packages' },
    /** The same, as they read inside a sentence ("Ignore people here"). */
    inSentence: { person: 'people', vehicle: 'vehicles', animal: 'animals', package: 'packages' } as Record<string, string>,
    alertOnlyFor: (what: string) => `Alert only for ${what} here`,
    alertOnlyAny: 'Alert only for things here',
    ignore: (what: string) => `Ignore ${what} here`,
    ignoreAll: 'Ignore everything here',
    ignoredArea: 'Ignored area',
    ignoredAreaN: (n: number) => `Ignored area ${n}`,
    presetLabel: {
      whole: 'Whole picture',
      left: 'Left half',
      right: 'Right half',
      top: 'Top half',
      bottom: 'Bottom half',
      bottomThird: 'Bottom third',
      middle: 'Middle',
    },
    presetName: {
      whole: 'Whole picture',
      left: 'Left side',
      right: 'Right side',
      top: 'Far side',
      bottom: 'Near side',
      bottomThird: 'Close to the camera',
      middle: 'Middle',
    },
  },
  // Instant Alerts / Hub pairing (bridge.ts)
  bridge: {
    waitingKey: 'Waiting for your Instant Alerts key from iCloud Keychain. Try again in a few minutes.',
    noPush: 'Push is not configured in this build (missing EAS project ID).',
    notPaired: 'Instant Alerts are not paired yet.',
    unreachable: 'Could not reach the bridge',
    badSecret: 'The bridge rejected the secret. Re-copy the snippet and restart the container.',
    httpError: (status: number, text: string) => `Bridge returned HTTP ${status}: ${text}`,
    addFrigate: 'Add a Frigate system first.',
  },
  // Home & Away (presence/geofence.ts)
  presence: {
    needLocation: 'Location access is needed to set your home.',
    needAlways: 'Choose "Always Allow" for location so Sightline can notice when you get home.',
  },
  // Connection problems in plain words (util/errors.ts, net/connection.ts)
  errors: {
    refused: (name: string) =>
      `${name} is on the network but didn’t accept the connection at that address. Check the address (and port) in its app or on the device.`,
    noSuchHost: 'Couldn’t find an address called that. Check it for typos.',
    notFound: (name: string) => `Couldn’t find ${name} on this network. Make sure your phone is on your home Wi-Fi and ${name} is turned on.`,
    tls: (name: string) => `${name} answered, but its secure connection couldn’t be set up. Try the address with http:// in front.`,
    noAway: 'You’re away from home, and no away-from-home connection is set up yet (Settings → Away from home).',
    generic: (name: string) => `Couldn’t connect to ${name}.`,
    noAnswerViaVpn: (name: string) => `Connected to home, but ${name} didn’t answer. Make sure it’s turned on.`,
    wrongLogin: 'Wrong username or password',
    loginFailed: (status: number) => `Login failed (HTTP ${status})`,
    httpStatus: (name: string, status: number) => `${name} returned HTTP ${status}`,
    sameNetwork: (message: string, name: string) => `${message}. Is the phone on the same network as ${name}?`,
    expoGoTls: "Couldn't connect. Expo Go can't accept self-signed certificates; use an http:// address for previews.",
    unreachable: (name: string) => `Couldn't reach ${name} on this network`,
    cannotExport: 'This system cannot export clips.',
  },
};

export default alerts;
