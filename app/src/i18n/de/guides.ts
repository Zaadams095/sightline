import type en from '../en/guides.ts';
import { plural } from '../plural.ts';

const p = plural('de');

// Menu names inside each brand's own app stay in English, as in en/guides.ts.
const guides: typeof en = {
  comeBack: 'Komm hierher zurück und tippe auf „Weiter“.',
  badAddress: 'Das sieht nicht nach einer Kameraadresse aus. Sie sollte so aussehen: 192.168.1.50.',
  alt: {
    pickAnother: 'Andere Marke wählen',
    findOnWifi: 'Kameras in meinem WLAN suchen',
    haveLink: 'Ich habe einen Stream-Link (rtsp://…)',
    seeWorking: 'Kameras ansehen, die mit Sightline funktionieren',
  },
  groups: {
    camera: 'WLAN-Kameras',
    recorder: 'Kameras mit Rekorder und Profi-Marken',
    cloud: 'Reine Cloud-Kameras',
  },
  apps: {
    amcrest: 'Amcrest Smart Home oder Amcrest View Pro',
    lorex: 'Lorex Home oder Lorex Cloud',
  },
  tapo: {
    plugin: {
      title: 'Kamera mit Netzkabel',
      detail: 'Die meisten Tapo-Kameras mit Stromkabel',
      steps: [
        'Öffne die Tapo-App und tippe auf deine Kamera.',
        'Tippe oben rechts auf das Zahnrad, dann auf Advanced Settings → Camera Account.',
        'Tippe auf „Understand and Agree to Use“. Lege einen Benutzernamen und ein Passwort an (je 6 bis 32 Zeichen) und schreib sie dir auf. Das ist nur für die Kamera, nicht dein Tapo-Login.',
      ],
      usernameLabel: 'Benutzername des Kamerakontos',
      usernameHint: 'Der Benutzername, den du gerade in der Tapo-App angelegt hast.',
      passwordLabel: 'Passwort des Kamerakontos',
      passwordHint: 'Nicht das Passwort deines Tapo-Logins.',
      cameraName: 'Tapo-Kamera',
    },
    battery: {
      title: 'Akkukamera oder Türklingel',
      detail: 'Wie die C400, C420, C425 oder eine Akku-Türklingel',
      why: 'Tapo-Akkukameras schlafen zwischen Aufnahmen, um Strom zu sparen, und senden Video deshalb nur an die Tapo-App. Sightline kann sie nicht zeigen, funktioniert aber mit Tapo-Kameras, die an der Steckdose hängen.',
      usePlugin: 'Tapo-Kamera mit Netzkabel einrichten',
    },
  },
  wyze: {
    v3: {
      title: 'Wyze Cam v3 oder Pan v3',
      detail: 'Mit dem neuesten Update der Kamera',
      steps: [
        'Aktualisiere die Wyze-App und dann die Kamera (Kameraeinstellungen → Device Info → Firmware).',
        'Tippe in den Einstellungen der Kamera auf Advanced Settings → RTSP und schalte es ein.',
        'Lege einen Benutzernamen und ein Passwort an (4 bis 10 Buchstaben oder Ziffern) und tippe auf Generate URL.',
        'Tippe auf Copy, um den angezeigten Link zu kopieren.',
      ],
      usernameLabel: 'RTSP-Benutzername',
      usernameHint: 'Der Benutzername, den du gerade in der Wyze-App angelegt hast.',
      passwordLabel: 'RTSP-Passwort',
      cameraName: 'Wyze-Kamera',
    },
    other: {
      title: 'Wyze Cam v4, OG, Türklingel oder Akkukamera',
      why: 'Diese Wyze-Kameras senden Video vorerst nur an die Wyze-App. Wyze hat eine Stream-Option für die Cam v4 angekündigt, aber sie ist noch nicht da. Sobald sie kommt, komm zurück und wähle „Wyze Cam v3 oder Pan v3“ – die Schritte sind dieselben.',
    },
  },
  eufy: {
    rtsp: {
      title: 'Kamera mit „NAS (RTSP)“',
      detail: 'Die meisten eufy-Kameras mit Netzkabel',
      steps: [
        'Öffne die eufy Security-App, tippe auf deine Kamera und dann auf das Zahnrad für ihre Einstellungen.',
        'Suche Storage → NAS (RTSP) und schalte es ein. Wenn du es nicht siehst, kann diese Kamera kein Video teilen (siehe „Andere eufy-Kameras“).',
        'Wähle „Continuous“, damit immer Video da ist, lege Benutzername und Passwort fest und kopiere den angezeigten Link.',
      ],
      usernameLabel: 'RTSP-Benutzername',
      usernameHint: 'Der Benutzername aus dem Bildschirm NAS (RTSP) in der eufy-App.',
      passwordLabel: 'RTSP-Passwort',
      cameraName: 'eufy-Kamera',
    },
    other: {
      title: 'Andere eufy-Kameras',
      detail: 'Kein „NAS (RTSP)“ in der App',
      why: 'Manche eufy-Kameras, vor allem Akkukameras, senden Video nur an die eufy-App. Wenn die App für die Kamera keine Einstellung „NAS (RTSP)“ hat, kann Sightline sie nicht zeigen.',
      checkAgain: 'Nochmal nach „NAS (RTSP)“ schauen',
    },
  },
  imou: {
    camera: {
      title: 'Imou-Kamera',
      detail: 'Die meisten Modelle mit Netzkabel',
      steps: [
        'Such den Aufkleber auf der Kamera (oft unten). Achte auf „Safety code“ oder „SC“, einen kurzen Code aus Buchstaben und Ziffern.',
        'Mach ein Foto davon oder schreib ihn genau ab. Großbuchstaben sind wichtig.',
      ],
      usernameHint: 'Imou-Kameras verwenden „admin“.',
      passwordLabel: 'Sicherheitscode',
      passwordHint: 'Der Code vom Aufkleber, auch wenn du das Passwort in der Imou-App geändert hast.',
      cameraName: 'Imou-Kamera',
    },
  },
  ezviz: {
    camera: {
      title: 'EZVIZ-Kamera',
      detail: 'Viele Modelle mit Netzkabel',
      steps: [
        'Such den Aufkleber auf der Kamera und notiere den 6-stelligen „Verification code“. Großbuchstaben sind wichtig.',
        'Tippe in der EZVIZ-App auf dein Profil → Settings → LAN Live View → Start Scanning und wähle deine Kamera.',
        'Tippe auf das Zahnrad → Local Server Settings und schalte RTSP ein. Gibt es keinen RTSP-Schalter, kann diese Kamera kein Video teilen.',
      ],
      usernameHint: 'EZVIZ-Kameras verwenden „admin“.',
      passwordLabel: 'Verifizierungscode',
      passwordHint: 'Der Code vom Aufkleber der Kamera.',
      cameraName: 'EZVIZ-Kamera',
    },
  },
  kasa: {
    all: {
      title: 'Kasa-Kamera',
      why: 'Kasa-Kameras senden Video nur an die Kasa-App, deshalb kann Sightline sie nicht zeigen. Die Tapo-Kameras von TP-Link (dieselbe Firma) funktionieren dagegen mit Sightline.',
      useTapo: 'Tapo-Kamera einrichten',
    },
  },
  reolink: {
    wired: {
      title: 'Kamera mit Netzkabel, Rekorder oder Home Hub',
      detail: 'Alles mit Stromkabel, ein Rekorder oder ein Home Hub',
      steps: [
        'Halte dein Reolink-Passwort bereit (das für die Kamera oder den Rekorder in der Reolink-App).',
        'Wenn du einen Rekorder oder Home Hub hast, nimm den: Jede Kamera daran erscheint in Sightline, auch Akkukameras.',
      ],
    },
    battery: {
      title: 'Einzelne Akkukamera',
      detail: 'Argus, Altas, Akku-Türklingel, ohne Home Hub',
      why: 'Reolink-Akkukameras schlafen, um Strom zu sparen, und sprechen allein deshalb nur mit der Reolink-App. Mit einem Reolink Home Hub oder Rekorder verbunden, funktionieren sie in Sightline.',
      haveHub: 'Ich habe einen Home Hub oder Rekorder',
    },
    lte: {
      title: '4G-/LTE-Kamera (mit SIM-Karte)',
      why: 'Die 4G-Kameras von Reolink nutzen das Mobilfunknetz statt deines WLANs, deshalb erreicht sie nur die Reolink-App.',
    },
  },
  amcrest: {
    all: {
      title: 'Amcrest-Kamera oder -Rekorder',
      steps: [
        'Halte das Admin-Passwort der Kamera (oder des Rekorders) bereit – das, das du bei der ersten Einrichtung angelegt hast.',
        'Wenn deine Kameras an einem Rekorder hängen, nimm die Adresse des Rekorders: Dann erscheinen alle seine Kameras auf einmal.',
      ],
    },
  },
  lorex: {
    recorder: {
      title: 'Rekorder (eine Box, an der deine Kameras hängen)',
      detail: 'Die meisten Lorex-NVR- und -DVR-Sets',
      steps: [
        'Öffne auf dem Bildschirm des Rekorders Main Menu → Network, um seine IP-Adresse zu sehen, oder schau unter Device info in der Lorex-App.',
        'Halte das Admin-Passwort des Rekorders bereit (das, das du am Bildschirm des Rekorders verwendest).',
      ],
    },
    wifi: {
      title: 'WLAN- oder Akkukamera ohne Rekorder',
      detail: 'Nur in der Lorex Home-App eingerichtet',
      why: 'Die meisten Lorex-WLAN- und Akkukameras ohne Rekorder senden Video nur an die Lorex-App. Wenn deine an einem Lorex-Rekorder hängt, füge stattdessen den Rekorder hinzu – dann erscheint sie.',
      onRecorder: 'Sie hängt an einem Lorex-Rekorder',
    },
  },
  swann: {
    recorder: {
      title: 'Rekorder (eine Box, an der deine Kameras hängen)',
      detail: 'Die meisten Swann-NVR- und -DVR-Sets',
      steps: [
        'Öffne auf dem Bildschirm des Rekorders das Menü → Network, um seine IP-Adresse zu sehen.',
        'Halte das Admin-Passwort des Rekorders bereit (das, das du am Bildschirm des Rekorders verwendest).',
      ],
    },
    wifi: {
      title: 'WLAN- oder Akkukamera ohne Rekorder',
      why: 'Die WLAN- und Akkukameras von Swann senden Video nur an die Swann Security-App, deshalb kann Sightline sie nicht zeigen.',
      haveRecorder: 'Ich habe einen Swann-Rekorder',
    },
  },
  annke: {
    all: {
      title: 'Annke-Kamera oder -Rekorder',
      steps: [
        'Halte das Admin-Passwort bereit – das, das du bei der ersten Einrichtung der Kamera oder des Rekorders angelegt hast.',
        'Wenn deine Kameras an einem Rekorder hängen, nimm den Rekorder: Dann erscheinen alle seine Kameras auf einmal.',
      ],
    },
  },
  hikvision: {
    all: {
      title: 'Hikvision-Kamera oder -Rekorder',
      detail: 'Auch HiWatch, LTS und andere Marken aus dem Hause Hikvision',
      steps: ['Halte das Admin-Passwort bereit, mit dem du dich am Rekorder anmeldest (nicht dein Hik-Connect-Konto).'],
    },
  },
  dahua: {
    all: {
      title: 'Dahua-Kamera oder -Rekorder',
      steps: ['Halte das Admin-Passwort bereit, das du am Bildschirm des Rekorders verwendest.'],
    },
  },
  ubiquiti: {
    all: {
      steps: [
        'Öffne an einem Computer deine UniFi-Konsole und geh zu Admins & Users → füge einen neuen Admin hinzu.',
        'Wähle „Restrict to local access only“, gib ihm Zugriff auf Protect und lege Benutzername und Passwort fest.',
      ],
    },
  },
  cloudWhy: {
    ring: 'Ring-Kameras senden Video nur an die Cloud von Ring, und Ring lässt keine anderen Apps zuschauen. Das ist Rings Entscheidung, kein Fehler deiner Kamera. Nutze für diese Kameras weiter die Ring-App.',
    nest: 'Nest-Kameras senden Video nur an die Cloud von Google. Google bietet Apps wie Sightline keine Möglichkeit, sie in deinem Heimnetz zu zeigen. Nutze für diese Kameras weiter die Google Home-App.',
    arlo: 'Arlo-Kameras senden Video nur an die Cloud von Arlo, deshalb kann Sightline sie nicht zeigen. Nutze für diese Kameras weiter die Arlo-App.',
    blink: 'Blink-Kameras senden Video nur an die Cloud von Blink, deshalb kann Sightline sie nicht zeigen. Nutze für diese Kameras weiter die Blink-App.',
    simplisafe:
      'SimpliSafe-Kameras gehören zum eigenen System von SimpliSafe und teilen kein Video mit anderen Apps. Nutze für diese Kameras weiter die SimpliSafe-App.',
  },

  parts: {
    stepOf: (step: number, total: number, label: string) => `Schritt ${step} von ${total} · ${label}`,
    stepOfA11y: (step: number, total: number, label: string) => `Schritt ${step} von ${total}: ${label}`,
    titleDetail: (title: string, detail: string) => `${title}. ${detail}`,
    starting: 'Wird gestartet …',
    findIt: 'In meinem WLAN suchen',
    looking: 'Wird gesucht …',
    lookingDetail: (status: string) => `${status} Wenn dein Handy fragt, ob es Geräte in deinem Netzwerk suchen darf, tippe auf „Erlauben“.`,
    notFound: 'Nicht gefunden. Prüfe, ob die Kamera an ist und dein Handy im selben WLAN ist, oder gib unten ihre Adresse ein.',
    found: (n: number) => p(n, { one: 'Eine gefunden. Ist es diese?', other: `${n} gefunden. Tippe auf die, die du einrichtest.` }),
    lookAgain: 'Nochmal suchen',
  },

  screen: {
    missingTitle: 'Versuchen wir es anders',
    missingBody: 'Diese Anleitung ist nicht verfügbar. Wähle deine Marke noch einmal oder lass Sightline nach deinen Kameras suchen.',
    pickBrand: 'Meine Marke wählen',
    findOnWifi: 'Kameras in meinem WLAN suchen',
    stageWhich: 'Welche Kamera',
    stageReady: 'Vorbereiten',
    stageConnect: 'Verbinden',
    whichOne: (brand: string) => `Welches ${brand}-Modell hast du?`,
    notSure: 'Nicht sicher? Schau dir die Kamera an: Hat sie ein Stromkabel, hängt sie am Netz.',
    differentOne: 'Ich habe eine andere',
    stepsAgain: 'Schritte nochmal zeigen',
  },
  unsupported: {
    title: 'Diese Kamera kann Sightline nicht beitreten',
    nothingWrong: 'Mit deiner Kamera ist alles in Ordnung, und deine anderen Kameras können trotzdem hier sein.',
    whatYouCanDo: 'Was du tun kannst',
  },
  system: {
    where: (brand: string) => `Wo ist dein ${brand}?`,
    body: 'Sightline kann im WLAN zu Hause danach suchen, damit du die Adresse nicht eintippen musst.',
    typeAddress: 'Ich tippe die Adresse ein',
  },
  connect: {
    title: (camera: string) => `${camera} verbinden`,
    body: 'Nur die Adresse der Kamera und das Konto, das du angelegt hast. Den Rest macht Sightline.',
    noLink: (app: string) => `Es ist noch kein Link kopiert. Tippe in der ${app}-App neben dem Link auf Copy und versuch es dann nochmal.`,
    ipCameras: 'IP-Kameras',
    theCamera: 'die Kamera',
    badAddress: 'Diese Adresse sieht nicht richtig aus. Sie sollte so aussehen: 192.168.1.50.',
    copiedFrom: (app: string) => `Link aus der ${app}-App kopiert?`,
    paste: 'Link einfügen',
    pastedWithAccount: 'Link eingefügt. Benutzername und Passwort sind schon enthalten.',
    pastedNoAccount: 'Link eingefügt. Gib unten Benutzername und Passwort ein.',
    address: 'Kameraadresse',
    addressHint: (app: string) => `Oder such sie in der ${app}-App: Kameraeinstellungen → Device info (oder Network). Sie sieht so aus: 192.168.1.50.`,
    username: 'Benutzername',
    password: 'Passwort',
    name: 'Name',
    namePlaceholder: 'Haustür',
    away: 'Auch unterwegs erreichen',
    awayDetail: 'Nutzt dein eigenes VPN, falls du eins eingerichtet hast (Einstellungen → Unterwegs).',
    showLink: 'Link zeigen, den Sightline nutzt',
    addAnyway: 'Trotzdem hinzufügen',
    connect: 'Verbinden',
  },
};

export default guides;
