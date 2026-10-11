import { plural } from '../plural.ts';

const p = plural('en');

/** "Export for police or insurance" (screen, PDF summary, READ ME) and "Share with neighbors". */
const exporting = {
  // export/window.ts
  window: {
    last30: 'Last 30 minutes',
    last2h: 'Last 2 hours',
    lastNight: 'Last night (8 PM – 7 AM)',
    endBeforeStart: 'The end time must be after the start time.',
    notYet: 'That time hasn’t happened yet.',
    tooLong: 'Pick 24 hours or less. For longer, make a few exports.',
    sizeWarning: (size: string) =>
      `This could be about ${size}. That’s a lot to send by Mail or Messages. AirDrop or Save to Files works best, or pick a shorter time or fewer cameras.`,
    replayWarning: (duration: string) =>
      `Some of your cameras can only play back recordings at normal speed, so copying their video takes about ${duration}. Keep Sightline open until it finishes.`,
  },
  // app/export.tsx
  screen: {
    title: 'Export for police or insurance',
    intro:
      'Sightline gathers video from every camera for the time you pick, with a PDF summary for whoever you send it to. It’s made on this iPhone and only leaves it when you share it.',
    checking: 'Checking…',
    noRecordings: 'No recordings in this time',
    events: (n: number) => p(n, { one: `${n} event`, other: `${n} events` }),
    video: 'Video',
    videoReplay: 'Video, copied at normal speed',
    snapshotsOnly: 'Snapshots only — this recorder doesn’t let apps save video',
    gettingReady: 'Getting ready…',
    failed: 'The export didn’t finish',
    beforeYouStart: 'Before you start',
    startExport: 'Start export',
    readyTitle: 'Export ready',
    readyHeading: 'Your export is ready',
    signedByPhone: 'signed by this iPhone',
    noVideoFrom: 'No video from',
    shareAgain: 'Share or save again',
    when: 'When',
    pickTime: 'Pick a time',
    fromRecording: 'From the recording you were watching',
    pickDifferent: 'Tap to pick a different time',
    from: 'From',
    until: 'Until',
    cameras: 'Cameras',
    camerasFooter: 'Cameras with recordings or events in this time are picked for you.',
    noCameras: 'No cameras with recordings',
    noCamerasDetail: 'Exports need a recorder (NVR, Frigate, Sightline Hub…).',
    aboutSize: (size: string) => `About ${size} of video.`,
    snapshotsOnlyFrom: (names: string) =>
      `Snapshots only from ${names}: the recorder doesn’t let apps save its video, so only event snapshots are included.`,
    makeExport: 'Make export',
    makingTitle: 'Making your export',
    soFar: (size: string) => `${size} so far`,
    keepOpen: 'Keep Sightline open until this finishes. The screen stays on.',
  },
  // export/run.ts
  run: {
    copying: (camera: string) => `Copying ${camera}…`,
    fingerprints: 'Calculating fingerprints…',
    writingSummary: 'Writing the summary…',
    packing: 'Packing the .zip…',
    noteReplay: 'Copied from the recorder’s playback at normal speed',
    noteFiles: 'The recorder’s own files covering this time (they may start a little earlier or end a little later)',
    noteNone: 'This recorder doesn’t let apps save its video, so only event snapshots are included',
    noteNoVideo: 'The recorder didn’t send video for this time',
    someParts: (note: string) => `${note} (some parts couldn’t be copied)`,
    tooBig: 'This export is too big to pack on this version of Sightline. Pick a shorter time or fewer cameras.',
    unreachable: 'This recorder isn’t reachable from this network.',
    shareTitle: 'Video export',
  },
  // READ ME.txt in the .zip (file names stay as they are)
  readme: {
    intro: 'Video export made with Sightline.',
    summary: 'What is in this export: cameras, the time covered (with time zone), events and fingerprints.',
    video: 'Video files, named by camera and local start time.',
    photos: 'Snapshots of events.',
    manifest: 'The SHA-256 fingerprint of every file. If any file is changed, its fingerprint won’t match.',
    signature: 'Signature of manifest.json, made with a key that never leaves the iPhone that made this export.',
    publicKey: 'The matching public key.',
    checkSignature: 'To check the signature:',
    checkFile: 'To check a file: sha256sum "video/<file>.mp4" (Mac: shasum -a 256) and compare with manifest.json.',
  },
  // export/report-html.ts: the PDF summary (may contain simple HTML tags)
  report: {
    title: 'Video export',
    homeCameras: 'Home cameras',
    videoIncluded: 'Video included',
    videoPartial: 'Some video included',
    videoNone: 'No video — snapshots only',
    until: (time: string) => `until ${time}`,
    signed: (q: { manifest: string; signature: string; publicKey: string; fingerprint: string }) =>
      `The list of fingerprints (${q.manifest}) is also <b>signed</b> with a key that never leaves the iPhone that made this export.
The signature is in ${q.signature} and the matching public key in ${q.publicKey}
(key fingerprint ${q.fingerprint}).
If the list is edited, the signature no longer checks out. To check it:`,
    unsigned:
      'This export isn’t signed (the app version that made it couldn’t sign), but the fingerprints below still show whether any file was changed.',
    summary: 'Summary',
    timeCovered: 'Time covered',
    isoRange: (start: string, end: string) => `${start} to ${end}`,
    cameras: 'Cameras',
    eventsInTime: 'Events in this time',
    exported: 'Exported',
    madeWith: 'Made with',
    madeWithValue: (app: string, device: string) => `${app} on ${device}`,
    missing: (names: string) =>
      `These cameras couldn’t export video for this time, so only their event snapshots are included: ${names}.`,
    colCamera: 'Camera',
    colSystem: 'System',
    colVideo: 'Video',
    colEvents: 'Events',
    colNotes: 'Notes',
    events: 'Events',
    colTime: 'Time',
    colWhat: 'What',
    more: (n: number) => `…and ${n} more, listed in manifest.json.`,
    noEvents: 'No events were recorded in this time.',
    howToTell: 'How to tell nothing was changed',
    howToTellBody: (manifest: string) =>
      `Every file in this export has a <b>fingerprint</b> (SHA-256), listed below and in ${manifest}.
A fingerprint is calculated from every byte of the file: <b>if any file is changed, even by one frame, its fingerprint won’t match.</b>
This report’s own fingerprint is in manifest.json.`,
    files: 'Files and fingerprints',
    colFile: 'File',
    colSize: 'Size',
    phoneZone: 'the phone’s time zone',
    timesShown: (zone: string, offset: string) =>
      `Times are shown in ${zone} (${offset}). Camera clocks can drift from true time by a few seconds.`,
  },
  // app/share-neighbors.tsx
  neighbors: {
    title: 'Share with neighbors',
    intro: 'For a neighborhood group or a neighbor. Blurring happens on this iPhone; nothing is uploaded until you share.',
    noneFound: 'No faces or license plates were found. Look it over before you share.',
    faces: (n: number) => p(n, { one: `${n} face`, other: `${n} faces` }),
    plates: (n: number) => p(n, { one: `${n} license plate`, other: `${n} license plates` }),
    blurred: (what: string) => `Blurred ${what}. Automatic blurring can miss some, so look it over before you share.`,
    gettingVideo: 'Getting the video…',
    gettingPhoto: 'Getting the photo…',
    blurring: 'Blurring faces and plates…',
    notBlurred: 'Not blurred. Faces and license plates will be visible.',
    couldntPrepare: 'Couldn’t prepare it',
    checkTitle: 'Check before sharing',
    startOver: 'Start over',
    whatToShare: 'What to share',
    videoClip: 'Video clip',
    photo: 'Photo',
    noVideo: 'This recorder can’t make video clips for sharing, so a photo is shared instead.',
    blurFooter: 'Faces and license plates are found automatically and blurred in a copy. It can miss some, so you’ll see the result first.',
    updateFooter: 'Blurring needs the newest version of Sightline. Update the app to use it.',
    blurToggle: 'Blur faces and license plates',
    blurAndPreview: 'Blur and preview',
    preview: 'Preview',
    visibleWarning: 'Faces and license plates will be visible to everyone you share with.',
    preparing: 'Preparing',
  },
};

export default exporting;
