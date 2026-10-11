/** Wall display (iPad on the wall) and its settings. */
const wall = {
  // app/wall.tsx
  display: {
    camera: 'Camera',
    ring: 'Someone’s at the door',
    tapToAnswer: (camera: string) => `${camera} · tap to answer`,
    notReachable: (names: string) => `${names} not reachable`,
    showControls: 'Show wall display controls',
    connecting: 'Connecting to your cameras…',
    exit: 'Exit wall display',
  },
  // wall/schedule.ts: "6 cameras · all connected"
  status: {
    noCameras: 'No cameras',
    allConnected: 'all connected',
    notConnected: (n: number) => `${n} not connected`,
  },
  // app/settings/wall.tsx
  settings: {
    title: 'Wall display',
    intro: 'Turns this iPad into an always-on camera wall: it goes through your cameras, shows the doorbell when someone rings, and dims at night.',
    start: 'Start wall display',
    showCameras: 'Show cameras',
    grid: 'All at once (grid)',
    single: 'One at a time',
    gridEvery: 'With more cameras than fit, the next screenful shows every',
    singleEvery: 'Next camera every',
    camerasOnWall: 'Cameras on the wall',
    allCameras: 'All cameras',
    whenSomething: 'When something happens',
    whenFooter: 'Alerts follow your alert settings. After a while the wall goes back to the tour.',
    showDoorbell: 'Show the doorbell when someone rings',
    showAlert: 'Show a camera with a new alert',
    night: 'Night',
    dimAtNight: 'Dim at night',
    from: 'From',
    until: 'Until',
    levels: {
      little: 'A little',
      more: 'More',
      most: 'Most',
    } as Record<string, string>,
    clock: 'Clock and date',
    tablet: 'For a tablet on the wall',
    tipPower: '• Keep it plugged in. The screen stays on while the wall display is open.',
    tipGuided:
      '• To keep it on Sightline: Settings → Accessibility → Guided Access, turn it on, then open the wall display and press the top button three times.',
    tipBurnIn: '• To protect the screen, the picture moves a tiny bit every minute and the cameras swap places every 15 minutes.',
    tipLeave: '• Tap the screen to leave. If the app is locked, Face ID or your PIN is needed.',
  },
};

export default wall;
