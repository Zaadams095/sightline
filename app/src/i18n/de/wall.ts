import type en from '../en/wall.ts';

const wall: typeof en = {
  display: {
    camera: 'Kamera',
    ring: 'Jemand ist an der Tür',
    tapToAnswer: (camera) => `${camera} · zum Antworten tippen`,
    notReachable: (names) => `${names} nicht erreichbar`,
    showControls: 'Steuerung der Wandanzeige einblenden',
    connecting: 'Verbindung zu deinen Kameras …',
    exit: 'Wandanzeige beenden',
  },
  status: {
    noCameras: 'Keine Kameras',
    allConnected: 'alle verbunden',
    notConnected: (n) => `${n} nicht verbunden`,
  },
  settings: {
    title: 'Wandanzeige',
    intro: 'Macht dieses iPad zu einer Kamerawand, die immer an ist: Sie zeigt nacheinander deine Kameras, blendet die Türklingel ein, wenn jemand klingelt, und wird nachts dunkler.',
    start: 'Wandanzeige starten',
    showCameras: 'Kameras zeigen',
    grid: 'Alle zugleich (Raster)',
    single: 'Eine nach der anderen',
    gridEvery: 'Bei mehr Kameras als Platz kommt die nächste Seite alle',
    singleEvery: 'Nächste Kamera alle',
    camerasOnWall: 'Kameras auf der Wand',
    allCameras: 'Alle Kameras',
    whenSomething: 'Wenn etwas passiert',
    whenFooter: 'Meldungen folgen deinen Meldungseinstellungen. Nach einer Weile geht die Wand zurück zur Runde.',
    showDoorbell: 'Türklingel zeigen, wenn jemand klingelt',
    showAlert: 'Kamera mit neuer Meldung zeigen',
    night: 'Nacht',
    dimAtNight: 'Nachts abdunkeln',
    from: 'Von',
    until: 'Bis',
    levels: {
      little: 'Etwas',
      more: 'Mehr',
      most: 'Am meisten',
    },
    clock: 'Uhrzeit und Datum',
    tablet: 'Für ein Tablet an der Wand',
    tipPower: '• Lass es am Strom. Der Bildschirm bleibt an, solange die Wandanzeige offen ist.',
    tipGuided:
      '• Damit es bei Sightline bleibt: Einstellungen → Bedienungshilfen → Geführter Zugriff einschalten, dann die Wandanzeige öffnen und dreimal die obere Taste drücken.',
    tipBurnIn: '• Zum Schutz des Bildschirms verschiebt sich das Bild jede Minute ein winziges Stück, und die Kameras tauschen alle 15 Minuten die Plätze.',
    tipLeave: '• Zum Beenden auf den Bildschirm tippen. Ist die App gesperrt, brauchst du Face ID oder deine PIN.',
  },
};

export default wall;
