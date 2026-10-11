/**
 * The TV's words in English, Spanish, French, German and Brazilian Portuguese, picked from
 * the Apple TV's language (Settings → General → Language). Changing it restarts the app, so
 * choosing once at launch is enough. Plain module, no React: hub.ts and the tests use it too.
 */

const en = {
  tryAgain: 'Try again',
  connectAgain: 'Connect again',
  disconnect: 'Disconnect TV',
  // Pairing
  cantPair: 'This build can’t pair. Install Sightline from the App Store or TestFlight.',
  notFromSightline: 'That request didn’t come from Sightline.',
  connectingTo: (hub: string) => `Connecting to ${hub}…`,
  noNetwork: 'This Apple TV isn’t connected to a network.',
  scanHeading: 'Scan with your iPhone',
  scanBody:
    'Open the Camera app (or Sightline) on your iPhone and point it at the code. Your iPhone must be on the same Wi-Fi as this Apple TV, and you need a Sightline Hub.',
  thisTv: (address: string) => `This TV: ${address}`,
  // Grid, live, tour
  tour: 'Tour',
  noCameras: 'No cameras are shared with this TV.',
  liveUnavailable: 'Live video unavailable — showing snapshots',
  connecting: 'Connecting…',
  live: 'Live',
  otherCameras: '◀ ▶ other cameras',
  atTheDoor: 'Someone’s at the door',
  tourDoorbell: 'shows the doorbell when someone rings',
  // Hub errors
  removed: 'This TV was removed from the Hub. Connect it again from your iPhone.',
  hubHttp: (status: number) => `The Hub returned HTTP ${status}`,
  unreachable: 'The TV couldn’t reach the Hub. Is the TV on the same network as the Hub?',
  cantReach: (hub: string) => `Can’t reach ${hub}. Check that the Hub is on.`,
};

export type Strings = typeof en;

const es: Strings = {
  tryAgain: 'Reintentar',
  connectAgain: 'Volver a conectar',
  disconnect: 'Desconectar TV',
  cantPair: 'Esta versión no se puede vincular. Instala Sightline desde el App Store o TestFlight.',
  notFromSightline: 'Esa solicitud no vino de Sightline.',
  connectingTo: (hub) => `Conectando con ${hub}…`,
  noNetwork: 'Este Apple TV no está conectado a ninguna red.',
  scanHeading: 'Escanea con tu iPhone',
  scanBody:
    'Abre la app Cámara (o Sightline) en tu iPhone y apunta al código. Tu iPhone debe estar en la misma red Wi-Fi que este Apple TV, y necesitas un Sightline Hub.',
  thisTv: (address) => `Este TV: ${address}`,
  tour: 'Recorrido',
  noCameras: 'No hay cámaras compartidas con este TV.',
  liveUnavailable: 'Vídeo en directo no disponible: mostrando instantáneas',
  connecting: 'Conectando…',
  live: 'En directo',
  otherCameras: '◀ ▶ otras cámaras',
  atTheDoor: 'Hay alguien en la puerta',
  tourDoorbell: 'muestra el timbre cuando alguien llama',
  removed: 'Este TV se quitó del Hub. Vuelve a conectarlo desde tu iPhone.',
  hubHttp: (status) => `El Hub respondió HTTP ${status}`,
  unreachable: 'El TV no pudo conectar con el Hub. ¿Está el TV en la misma red que el Hub?',
  cantReach: (hub) => `No se puede conectar con ${hub}. Comprueba que el Hub esté encendido.`,
};

const fr: Strings = {
  tryAgain: 'Réessayer',
  connectAgain: 'Reconnecter',
  disconnect: 'Déconnecter la TV',
  cantPair: 'Cette version ne peut pas être associée. Installez Sightline depuis l’App Store ou TestFlight.',
  notFromSightline: 'Cette demande ne vient pas de Sightline.',
  connectingTo: (hub) => `Connexion à ${hub}…`,
  noNetwork: 'Cette Apple TV n’est connectée à aucun réseau.',
  scanHeading: 'Scannez avec votre iPhone',
  scanBody:
    'Ouvrez l’app Appareil photo (ou Sightline) sur votre iPhone et visez le code. Votre iPhone doit être sur le même Wi-Fi que cette Apple TV, et il vous faut un Sightline Hub.',
  thisTv: (address) => `Cette TV : ${address}`,
  tour: 'Visite',
  noCameras: 'Aucune caméra n’est partagée avec cette TV.',
  liveUnavailable: 'Vidéo en direct indisponible — affichage des photos',
  connecting: 'Connexion…',
  live: 'En direct',
  otherCameras: '◀ ▶ autres caméras',
  atTheDoor: 'Quelqu’un est à la porte',
  tourDoorbell: 'affiche la sonnette quand quelqu’un sonne',
  removed: 'Cette TV a été retirée du Hub. Reconnectez-la depuis votre iPhone.',
  hubHttp: (status) => `Le Hub a répondu HTTP ${status}`,
  unreachable: 'La TV n’a pas pu joindre le Hub. La TV est-elle sur le même réseau que le Hub ?',
  cantReach: (hub) => `Impossible de joindre ${hub}. Vérifiez que le Hub est allumé.`,
};

const de: Strings = {
  tryAgain: 'Erneut versuchen',
  connectAgain: 'Neu verbinden',
  disconnect: 'TV trennen',
  cantPair: 'Diese Version kann nicht koppeln. Installiere Sightline aus dem App Store oder über TestFlight.',
  notFromSightline: 'Diese Anfrage kam nicht von Sightline.',
  connectingTo: (hub) => `Verbinde mit ${hub} …`,
  noNetwork: 'Dieses Apple TV ist mit keinem Netzwerk verbunden.',
  scanHeading: 'Mit dem iPhone scannen',
  scanBody:
    'Öffne die Kamera-App (oder Sightline) auf deinem iPhone und richte sie auf den Code. Dein iPhone muss im selben WLAN wie dieses Apple TV sein, und du brauchst einen Sightline Hub.',
  thisTv: (address) => `Dieses TV: ${address}`,
  tour: 'Rundgang',
  noCameras: 'Mit diesem TV sind keine Kameras geteilt.',
  liveUnavailable: 'Live-Bild nicht verfügbar – zeige Schnappschüsse',
  connecting: 'Verbinde …',
  live: 'Live',
  otherCameras: '◀ ▶ andere Kameras',
  atTheDoor: 'Jemand ist an der Tür',
  tourDoorbell: 'zeigt die Türklingel, wenn jemand klingelt',
  removed: 'Dieses TV wurde vom Hub entfernt. Verbinde es neu über dein iPhone.',
  hubHttp: (status) => `Der Hub hat mit HTTP ${status} geantwortet`,
  unreachable: 'Das TV erreicht den Hub nicht. Ist das TV im selben Netzwerk wie der Hub?',
  cantReach: (hub) => `${hub} ist nicht erreichbar. Prüfe, ob der Hub eingeschaltet ist.`,
};

const ptBR: Strings = {
  tryAgain: 'Tentar de novo',
  connectAgain: 'Conectar de novo',
  disconnect: 'Desconectar TV',
  cantPair: 'Esta versão não pode ser emparelhada. Instale o Sightline pela App Store ou pelo TestFlight.',
  notFromSightline: 'Essa solicitação não veio do Sightline.',
  connectingTo: (hub) => `Conectando a ${hub}…`,
  noNetwork: 'Esta Apple TV não está conectada a nenhuma rede.',
  scanHeading: 'Escaneie com seu iPhone',
  scanBody:
    'Abra o app Câmera (ou o Sightline) no seu iPhone e aponte para o código. Seu iPhone precisa estar no mesmo Wi-Fi que esta Apple TV, e você precisa de um Sightline Hub.',
  thisTv: (address) => `Esta TV: ${address}`,
  tour: 'Ronda',
  noCameras: 'Nenhuma câmera foi compartilhada com esta TV.',
  liveUnavailable: 'Vídeo ao vivo indisponível — mostrando fotos',
  connecting: 'Conectando…',
  live: 'Ao vivo',
  otherCameras: '◀ ▶ outras câmeras',
  atTheDoor: 'Tem alguém na porta',
  tourDoorbell: 'mostra a campainha quando alguém toca',
  removed: 'Esta TV foi removida do Hub. Conecte de novo pelo seu iPhone.',
  hubHttp: (status) => `O Hub respondeu HTTP ${status}`,
  unreachable: 'A TV não conseguiu acessar o Hub. A TV está na mesma rede que o Hub?',
  cantReach: (hub) => `Não foi possível acessar ${hub}. Verifique se o Hub está ligado.`,
};

export type Lang = 'en' | 'es' | 'fr' | 'de' | 'pt-BR';

const TABLE: Record<Lang, Strings> = { en, es, fr, de, 'pt-BR': ptBR };

/** "es-MX" → es, "pt-PT"/"pt" → pt-BR (closest we have), anything else → en. */
export function pickLang(tag: string): Lang {
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === 'es' || base === 'fr' || base === 'de') return base;
  if (base === 'pt') return 'pt-BR';
  return 'en';
}

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

/** The Apple TV's locale, e.g. "de-DE" (also used to format the clock). */
export const locale = deviceLocale();
export const lang: Lang = pickLang(locale);
export const t: Strings = TABLE[lang];
