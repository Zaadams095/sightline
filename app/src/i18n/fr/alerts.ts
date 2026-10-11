import type en from '../en/alerts.ts';
import { plural } from '../plural.ts';

const p = plural('fr');

/** Ce que voient les caméras : [singulier, pluriel]. */
const THINGS: Record<string, [string, string]> = {
  person: ['personne', 'personnes'],
  people: ['personne', 'personnes'],
  face: ['visage', 'visages'],
  car: ['voiture', 'voitures'],
  vehicle: ['véhicule', 'véhicules'],
  truck: ['camion', 'camions'],
  bus: ['bus', 'bus'],
  motorcycle: ['moto', 'motos'],
  bicycle: ['vélo', 'vélos'],
  license_plate: ['plaque d’immatriculation', 'plaques d’immatriculation'],
  package: ['colis', 'colis'],
  animal: ['animal', 'animaux'],
  dog: ['chien', 'chiens'],
  cat: ['chat', 'chats'],
  bird: ['oiseau', 'oiseaux'],
  horse: ['cheval', 'chevaux'],
  deer: ['cerf', 'cerfs'],
  bear: ['ours', 'ours'],
  fox: ['renard', 'renards'],
  raccoon: ['raton laveur', 'ratons laveurs'],
  squirrel: ['écureuil', 'écureuils'],
  rabbit: ['lapin', 'lapins'],
  mouse: ['souris', 'souris'],
};

/**
 * Les lieux portent leur préposition (« chez Maman », « à la maison ») : les phrases
 * les placent tels quels (« Aucune activité chez Maman »).
 */
const alerts: typeof en = {
  ringHeadline: 'Quelqu’un est à la porte',
  activity: 'Activité',
  inZones: (zones: string) => ` dans ${zones}`,
  snoozeHour: 'Mettre cette caméra en sourdine 1 heure',
  snoozeMorning: 'Mettre cette caméra en sourdine jusqu’à 7 h',
  watch: 'Voir',
  health: {
    offline: (camera: string) => `${camera} est hors ligne`,
    offlineBody: (system: string) => `Aucune vidéo de cette caméra sur ${system}.`,
    storageFull: (system: string, pct: number) => `Le stockage de ${system} est plein à ${pct} %`,
    storageBody: (gb: number) => `Il reste ${gb} Go. Les vidéos les plus anciennes seront remplacées plus tôt que d’habitude.`,
    notResponding: (system: string) => `${system} ne répond pas`,
  },
  packages: {
    gotIt: 'Je l’ai récupéré',
    delivered: (camera: string) => `Colis livré · ${camera}`,
    arrivedAt: (time: string) => `Arrivé à ${time}.`,
    pickedUp: (camera: string) => `Le colis a peut-être été récupéré · ${camera}`,
    pickedUpBody: 'Quelqu’un est passé après la livraison, et le colis n’a plus été vu depuis.',
    stillAt: (where: string) => `Un colis attend toujours (${where})`,
    stillOutside: (n: number) => p(n, { one: `${n} colis attend toujours dehors`, other: `${n} colis attendent toujours dehors` }),
    reminderBody: 'Il a été livré plus tôt et personne ne l’a encore récupéré.',
    at: (where: string) => `Vu sur : ${where}.`,
  },
  learned: {
    notImportant: 'Pas important',
    alwaysTell: 'Toujours me prévenir',
    undo: 'Annuler',
    stopAlerting: 'Ne plus m’alerter pour ça',
    keepAlerting: 'Continuer à m’alerter',
    askTitle: 'Ne plus vous alerter pour ça ?',
    learnedTitle: 'Sightline a appris quelque chose',
    thing: (o: string, n: number) => {
      const f = THINGS[o];
      return f ? p(n, { one: f[0], other: f[1] }) : o.replace(/_/g, ' ');
    },
    motionAlerts: (n: number) => p(n, { one: 'alerte de mouvement', other: 'alertes de mouvement' }),
    comboAlerts: (things: string, n: number) => p(n, { one: `alerte ${things}`, other: `alertes ${things}` }),
    atNight: ' la nuit',
    duringDay: ' en journée',
    inZones: (zones: string) => ` dans ${zones}`,
    or: 'ou',
    title: (what: string, camera: string, extra: string) => `${what} sur ${camera}${extra}`,
    always: (what: string, camera: string) => `Vous avez demandé à toujours être prévenu : ${what} sur ${camera}. Rien ne sera mis en sourdine.`,
    counted: (n: number, what: string, camera: string, extra: string) => `${n} ${what} sur ${camera}${extra}`,
    askPeople: (what: string) =>
      `Vous avez marqué ${what} comme pas importants. Sightline ne met jamais de personnes en sourdine de lui-même : ne plus vous alerter pour ça ?`,
    willStop: (what: string) => `Vous avez marqué ${what} comme pas importants : Sightline ne vous alertera plus pour ça.`,
  },
  checkins: {
    placeOf: (who: string) => `chez ${who}`,
    placeNamed: (place: string) => `à ${place}`,
    home: 'à la maison',
    fine: (who: string) => `${who} va bien`,
    allFine: 'Tout va bien',
    theCameras: 'les caméras',
    or: 'ou',
    camera: 'caméra',
    lastActive: (camera: string, when: string) => `Dernière activité sur ${camera} : ${when}.`,
    notSeen: (cameras: string) => `Sightline n’a vu personne sur ${cameras} depuis le début de la surveillance.`,
    noActivityYet: (place: string) => `Aucune activité ${place} pour l’instant aujourd’hui`,
    itsNow: (time: string, last: string) => `Il est ${time}. ${last}`,
    noActivityFor: (place: string, h: number) =>
      p(h, { one: `Aucune activité ${place} depuis ${h} heure`, other: `Aucune activité ${place} depuis ${h} heures` }),
    allNormal: (place: string) => `Tout est normal ${place}`,
    summaryBody: (time: string, n: number) =>
      p(n, { one: `Première activité à ${time} · ${n} moment aujourd’hui.`, other: `Première activité à ${time} · ${n} moments aujourd’hui.` }),
    noActivityToday: (place: string) => `Aucune activité ${place} aujourd’hui`,
    notCheckedYet: 'Pas encore vérifié.',
    status: (time: string, n: number) =>
      p(n, { one: `Première activité aujourd’hui à ${time} · ${n} moment.`, other: `Première activité aujourd’hui à ${time} · ${n} moments.` }),
    noActivityYetToday: (last: string) => `Aucune activité pour l’instant aujourd’hui. ${last}`,
    watchCamera: (camera: string) => `Voir ${camera}`,
    call: (who: string) => `Appeler ${who}`,
    unconfirmedTitle: (place: string) => `Activité ${place} pas encore confirmée`,
    unconfirmedBody: (place: string, time: string) =>
      `Sightline n’a pas pu joindre les caméras ${place} pour vérifier avant ${time}. Touchez pour regarder. Sans Sightline Hub, les notifications de veille peuvent arriver en retard.`,
    today: (time: string) => `aujourd’hui à ${time}`,
    yesterday: (time: string) => `hier à ${time}`,
    onDay: (day: string, time: string) => `${day} à ${time}`,
    onDate: (month: string, day: number, time: string) => `le ${day} ${month} à ${time}`,
    dayNames: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    months: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  },
  zones: {
    objects: { person: 'Personnes', vehicle: 'Véhicules', animal: 'Animaux', package: 'Colis' },
    inSentence: { person: 'les personnes', vehicle: 'les véhicules', animal: 'les animaux', package: 'les colis' },
    alertOnlyFor: (what: string) => `M’alerter seulement pour ${what} ici`,
    alertOnlyAny: 'M’alerter seulement pour ce qui se passe ici',
    ignore: (what: string) => `Ignorer ${what} ici`,
    ignoreAll: 'Tout ignorer ici',
    ignoredArea: 'Zone ignorée',
    ignoredAreaN: (n: number) => `Zone ignorée ${n}`,
    presetLabel: {
      whole: 'Image entière',
      left: 'Moitié gauche',
      right: 'Moitié droite',
      top: 'Moitié haute',
      bottom: 'Moitié basse',
      bottomThird: 'Tiers du bas',
      middle: 'Centre',
    },
    presetName: {
      whole: 'Image entière',
      left: 'Côté gauche',
      right: 'Côté droit',
      top: 'Au fond',
      bottom: 'Devant',
      bottomThird: 'Près de la caméra',
      middle: 'Centre',
    },
  },
  bridge: {
    waitingKey: 'En attente de votre clé Alertes instantanées depuis le trousseau iCloud. Réessayez dans quelques minutes.',
    noPush: 'Les notifications push ne sont pas configurées dans cette version (ID de projet EAS manquant).',
    notPaired: 'Les Alertes instantanées ne sont pas encore jumelées.',
    unreachable: 'Impossible de joindre le relais',
    badSecret: 'Le relais a refusé la clé secrète. Recopiez le code et redémarrez le conteneur.',
    httpError: (status: number, text: string) => `Le relais a renvoyé HTTP ${status} : ${text}`,
    addFrigate: 'Ajoutez d’abord un système Frigate.',
  },
  presence: {
    needLocation: 'Sightline a besoin d’accéder à votre position pour enregistrer votre domicile.',
    needAlways: 'Choisissez « Toujours » pour la localisation afin que Sightline remarque quand vous rentrez.',
  },
  errors: {
    refused: (name: string) =>
      `${name} est sur le réseau mais n’a pas accepté la connexion à cette adresse. Vérifiez l’adresse (et le port) dans son app ou sur l’appareil.`,
    noSuchHost: 'Aucune adresse de ce nom n’a été trouvée. Vérifiez qu’il n’y a pas de faute de frappe.',
    notFound: (name: string) =>
      `${name} est introuvable sur ce réseau. Vérifiez que votre téléphone est sur le Wi-Fi de la maison et que ${name} est allumé.`,
    tls: (name: string) => `${name} a répondu, mais la connexion sécurisée n’a pas pu être établie. Essayez l’adresse avec http:// devant.`,
    noAway: 'Vous êtes hors de chez vous et aucune connexion à distance n’est encore configurée (Réglages → Hors de chez vous).',
    generic: (name: string) => `Impossible de se connecter à ${name}.`,
    noAnswerViaVpn: (name: string) => `Connecté à la maison, mais ${name} n’a pas répondu. Vérifiez qu’il est allumé.`,
    wrongLogin: 'Nom d’utilisateur ou mot de passe incorrect',
    loginFailed: (status: number) => `Échec de la connexion (HTTP ${status})`,
    httpStatus: (name: string, status: number) => `${name} a renvoyé HTTP ${status}`,
    sameNetwork: (message: string, name: string) => `${message}. Le téléphone est-il sur le même réseau que ${name} ?`,
    expoGoTls: 'Connexion impossible. Expo Go n’accepte pas les certificats autosignés ; utilisez une adresse http:// pour les aperçus.',
    unreachable: (name: string) => `Impossible de joindre ${name} sur ce réseau`,
    cannotExport: 'Ce système ne peut pas exporter d’extraits.',
  },
};

export default alerts;
