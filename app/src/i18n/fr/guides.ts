import type en from '../en/guides.ts';
import { plural } from '../plural.ts';

const p = plural('fr');

// Menu names inside each brand's own app stay in English, as in en/guides.ts.
const guides: typeof en = {
  comeBack: 'Revenez ici et touchez Suivant.',
  badAddress: 'Cela ne ressemble pas à l’adresse d’une caméra. Elle devrait ressembler à 192.168.1.50.',
  alt: {
    pickAnother: 'Choisir une autre marque',
    findOnWifi: 'Chercher des caméras sur mon Wi-Fi',
    haveLink: 'J’ai un lien de flux (rtsp://…)',
    seeWorking: 'Voir les caméras compatibles avec Sightline',
  },
  groups: {
    camera: 'Caméras Wi-Fi',
    recorder: 'Caméras avec enregistreur, et marques pro',
    cloud: 'Caméras uniquement dans le cloud',
  },
  apps: {
    amcrest: 'Amcrest Smart Home ou Amcrest View Pro',
    lorex: 'Lorex Home ou Lorex Cloud',
  },
  tapo: {
    plugin: {
      title: 'Caméra branchée',
      detail: 'La plupart des caméras Tapo avec un cordon d’alimentation',
      steps: [
        'Ouvrez l’app Tapo et touchez votre caméra.',
        'Touchez la roue dentée en haut à droite, puis Advanced Settings → Camera Account.',
        'Touchez « Understand and Agree to Use ». Créez un nom d’utilisateur et un mot de passe (6 à 32 caractères chacun) et notez-les. Ils servent uniquement à la caméra, pas à votre compte Tapo.',
      ],
      usernameLabel: 'Nom d’utilisateur du compte caméra',
      usernameHint: 'Le nom d’utilisateur que vous venez de créer dans l’app Tapo.',
      passwordLabel: 'Mot de passe du compte caméra',
      passwordHint: 'Pas le mot de passe de votre compte Tapo.',
      cameraName: 'Caméra Tapo',
    },
    battery: {
      title: 'Caméra sur batterie ou sonnette',
      detail: 'Comme la C400, C420, C425 ou une sonnette sur batterie',
      why: 'Les caméras Tapo sur batterie se mettent en veille entre deux enregistrements pour économiser l’énergie : elles n’envoient donc la vidéo qu’à l’app Tapo. Sightline ne peut pas les afficher, mais fonctionne avec les caméras Tapo branchées sur secteur.',
      usePlugin: 'Configurer une caméra Tapo branchée',
    },
  },
  wyze: {
    v3: {
      title: 'Wyze Cam v3 ou Pan v3',
      detail: 'Avec la dernière mise à jour de la caméra',
      steps: [
        'Mettez à jour l’app Wyze, puis la caméra (réglages de la caméra → Device Info → Firmware).',
        'Dans les réglages de la caméra, touchez Advanced Settings → RTSP et activez-le.',
        'Créez un nom d’utilisateur et un mot de passe (4 à 10 lettres ou chiffres), puis touchez Generate URL.',
        'Touchez Copy pour copier le lien affiché.',
      ],
      usernameLabel: 'Nom d’utilisateur RTSP',
      usernameHint: 'Le nom d’utilisateur que vous venez de créer dans l’app Wyze.',
      passwordLabel: 'Mot de passe RTSP',
      cameraName: 'Caméra Wyze',
    },
    other: {
      title: 'Wyze Cam v4, OG, sonnette ou caméra sur batterie',
      why: 'Pour l’instant, ces caméras Wyze n’envoient la vidéo qu’à l’app Wyze. Wyze a annoncé une option de flux pour la Cam v4, mais elle n’est pas encore sortie. Quand elle arrivera, revenez et choisissez « Wyze Cam v3 ou Pan v3 » : les étapes sont les mêmes.',
    },
  },
  eufy: {
    rtsp: {
      title: 'Caméra avec « NAS (RTSP) »',
      detail: 'La plupart des caméras eufy branchées',
      steps: [
        'Ouvrez l’app eufy Security, touchez votre caméra, puis la roue dentée pour ses réglages.',
        'Cherchez Storage → NAS (RTSP) et activez-le. Si vous ne le voyez pas, cette caméra ne peut pas partager sa vidéo (voir « Autres caméras eufy »).',
        'Choisissez « Continuous » pour que la vidéo soit toujours disponible, créez un nom d’utilisateur et un mot de passe, puis copiez le lien affiché.',
      ],
      usernameLabel: 'Nom d’utilisateur RTSP',
      usernameHint: 'Le nom d’utilisateur de l’écran NAS (RTSP) dans l’app eufy.',
      passwordLabel: 'Mot de passe RTSP',
      cameraName: 'Caméra eufy',
    },
    other: {
      title: 'Autres caméras eufy',
      detail: 'Pas de « NAS (RTSP) » dans l’app',
      why: 'Certaines caméras eufy, surtout celles sur batterie, n’envoient la vidéo qu’à l’app eufy. Si l’app ne propose pas le réglage « NAS (RTSP) » pour la caméra, Sightline ne peut pas l’afficher.',
      checkAgain: 'Chercher à nouveau « NAS (RTSP) »',
    },
  },
  imou: {
    camera: {
      title: 'Caméra Imou',
      detail: 'La plupart des modèles branchés',
      steps: [
        'Trouvez l’étiquette sur la caméra (souvent en dessous). Cherchez « Safety code » ou « SC », un court code de lettres et de chiffres.',
        'Prenez-le en photo ou recopiez-le exactement. Les majuscules comptent.',
      ],
      usernameHint: 'Les caméras Imou utilisent « admin ».',
      passwordLabel: 'Code de sécurité',
      passwordHint: 'Le code de l’étiquette, même si vous avez changé le mot de passe dans l’app Imou.',
      cameraName: 'Caméra Imou',
    },
  },
  ezviz: {
    camera: {
      title: 'Caméra EZVIZ',
      detail: 'De nombreux modèles branchés',
      steps: [
        'Trouvez l’étiquette sur la caméra et notez le « Verification code » de 6 lettres. Les majuscules comptent.',
        'Dans l’app EZVIZ, touchez votre profil → Settings → LAN Live View → Start Scanning, et choisissez votre caméra.',
        'Touchez la roue dentée → Local Server Settings, et activez RTSP. S’il n’y a pas d’interrupteur RTSP, cette caméra ne peut pas partager sa vidéo.',
      ],
      usernameHint: 'Les caméras EZVIZ utilisent « admin ».',
      passwordLabel: 'Code de vérification',
      passwordHint: 'Le code de l’étiquette de la caméra.',
      cameraName: 'Caméra EZVIZ',
    },
  },
  kasa: {
    all: {
      title: 'Caméra Kasa',
      why: 'Les caméras Kasa n’envoient la vidéo qu’à l’app Kasa, donc Sightline ne peut pas les afficher. Les caméras Tapo de TP-Link (la même entreprise) fonctionnent, elles, avec Sightline.',
      useTapo: 'Configurer une caméra Tapo',
    },
  },
  reolink: {
    wired: {
      title: 'Caméra branchée, enregistreur ou Home Hub',
      detail: 'Tout ce qui a un cordon d’alimentation, un enregistreur ou un Home Hub',
      steps: [
        'Gardez votre mot de passe Reolink à portée de main (celui de la caméra ou de l’enregistreur dans l’app Reolink).',
        'Si vous avez un enregistreur ou un Home Hub, utilisez-le : toutes ses caméras apparaîtront dans Sightline, même celles sur batterie.',
      ],
    },
    battery: {
      title: 'Caméra sur batterie seule',
      detail: 'Argus, Altas, sonnette sur batterie, sans Home Hub',
      why: 'Les caméras Reolink sur batterie se mettent en veille pour économiser l’énergie : seules, elles ne parlent qu’à l’app Reolink. Reliées à un Home Hub ou à un enregistreur Reolink, elles fonctionnent dans Sightline.',
      haveHub: 'J’ai un Home Hub ou un enregistreur',
    },
    lte: {
      title: 'Caméra 4G / LTE (avec carte SIM)',
      why: 'Les caméras 4G de Reolink utilisent le réseau mobile au lieu de votre Wi-Fi, donc seule l’app Reolink peut les joindre.',
    },
  },
  amcrest: {
    all: {
      title: 'Caméra ou enregistreur Amcrest',
      steps: [
        'Gardez à portée de main le mot de passe admin de la caméra (ou de l’enregistreur), celui créé lors de la première configuration.',
        'Si vos caméras sont sur un enregistreur, utilisez l’adresse de l’enregistreur : toutes ses caméras apparaissent d’un coup.',
      ],
    },
  },
  lorex: {
    recorder: {
      title: 'Enregistreur (un boîtier où se branchent vos caméras)',
      detail: 'La plupart des kits NVR et DVR Lorex',
      steps: [
        'Sur l’écran de l’enregistreur, ouvrez Main Menu → Network pour voir son adresse IP, ou regardez Device info dans l’app Lorex.',
        'Gardez à portée de main le mot de passe admin de l’enregistreur (celui que vous utilisez sur son écran).',
      ],
    },
    wifi: {
      title: 'Caméra Wi-Fi ou sur batterie sans enregistreur',
      detail: 'Configurée uniquement dans l’app Lorex Home',
      why: 'La plupart des caméras Lorex Wi-Fi et sur batterie sans enregistreur n’envoient la vidéo qu’à l’app Lorex. Si la vôtre est reliée à un enregistreur Lorex, ajoutez plutôt l’enregistreur : elle apparaîtra.',
      onRecorder: 'Elle est sur un enregistreur Lorex',
    },
  },
  swann: {
    recorder: {
      title: 'Enregistreur (un boîtier où se branchent vos caméras)',
      detail: 'La plupart des kits NVR et DVR Swann',
      steps: [
        'Sur l’écran de l’enregistreur, ouvrez le menu → Network pour voir son adresse IP.',
        'Gardez à portée de main le mot de passe admin de l’enregistreur (celui que vous utilisez sur son écran).',
      ],
    },
    wifi: {
      title: 'Caméra Wi-Fi ou sur batterie sans enregistreur',
      why: 'Les caméras Wi-Fi et sur batterie de Swann n’envoient la vidéo qu’à l’app Swann Security, donc Sightline ne peut pas les afficher.',
      haveRecorder: 'J’ai un enregistreur Swann',
    },
  },
  annke: {
    all: {
      title: 'Caméra ou enregistreur Annke',
      steps: [
        'Gardez à portée de main le mot de passe admin, celui créé lors de la première configuration de la caméra ou de l’enregistreur.',
        'Si vos caméras sont sur un enregistreur, utilisez l’enregistreur : toutes ses caméras apparaissent d’un coup.',
      ],
    },
  },
  hikvision: {
    all: {
      title: 'Caméra ou enregistreur Hikvision',
      detail: 'Aussi HiWatch, LTS et d’autres marques fabriquées par Hikvision',
      steps: ['Gardez à portée de main le mot de passe admin, celui qui sert à se connecter à l’enregistreur (pas votre compte Hik-Connect).'],
    },
  },
  dahua: {
    all: {
      title: 'Caméra ou enregistreur Dahua',
      steps: ['Gardez à portée de main le mot de passe admin, celui que vous utilisez sur l’écran de l’enregistreur.'],
    },
  },
  ubiquiti: {
    all: {
      steps: [
        'Sur un ordinateur, ouvrez votre console UniFi et allez dans Admins & Users → ajoutez un nouvel admin.',
        'Choisissez « Restrict to local access only », donnez-lui accès à Protect, et créez un nom d’utilisateur et un mot de passe.',
      ],
    },
  },
  cloudWhy: {
    ring: 'Les caméras Ring envoient la vidéo uniquement au cloud de Ring, et Ring ne laisse pas d’autres apps les regarder. C’est un choix de Ring, pas un problème de votre caméra. Continuez à utiliser l’app Ring pour celles-ci.',
    nest: 'Les caméras Nest envoient la vidéo uniquement au cloud de Google. Google ne permet pas aux apps comme Sightline de les afficher sur votre réseau local. Continuez à utiliser l’app Google Home pour celles-ci.',
    arlo: 'Les caméras Arlo envoient la vidéo uniquement au cloud d’Arlo, donc Sightline ne peut pas les afficher. Continuez à utiliser l’app Arlo pour celles-ci.',
    blink: 'Les caméras Blink envoient la vidéo uniquement au cloud de Blink, donc Sightline ne peut pas les afficher. Continuez à utiliser l’app Blink pour celles-ci.',
    simplisafe:
      'Les caméras SimpliSafe font partie du système de SimpliSafe et ne partagent pas leur vidéo avec d’autres apps. Continuez à utiliser l’app SimpliSafe pour celles-ci.',
  },

  parts: {
    stepOf: (step: number, total: number, label: string) => `Étape ${step} sur ${total} · ${label}`,
    stepOfA11y: (step: number, total: number, label: string) => `Étape ${step} sur ${total} : ${label}`,
    titleDetail: (title: string, detail: string) => `${title}. ${detail}`,
    starting: 'Démarrage…',
    findIt: 'La trouver sur mon Wi-Fi',
    looking: 'Recherche en cours…',
    lookingDetail: (status: string) => `${status} Si votre téléphone demande à trouver des appareils sur votre réseau, touchez Autoriser.`,
    notFound: 'Introuvable. Vérifiez que la caméra est allumée et que votre téléphone est sur le même Wi-Fi, ou saisissez son adresse ci-dessous.',
    found: (n: number) => p(n, { one: 'Une trouvée. Est-ce celle-ci ?', other: `${n} trouvées. Touchez celle que vous configurez.` }),
    lookAgain: 'Chercher à nouveau',
  },

  screen: {
    missingTitle: 'Essayons autrement',
    missingBody: 'Ce guide n’est pas disponible. Choisissez à nouveau votre marque, ou laissez Sightline chercher vos caméras.',
    pickBrand: 'Choisir ma marque',
    findOnWifi: 'Chercher des caméras sur mon Wi-Fi',
    stageWhich: 'Quelle caméra',
    stageReady: 'Préparation',
    stageConnect: 'Connexion',
    whichOne: (brand: string) => `Quel modèle ${brand} avez-vous ?`,
    notSure: 'Vous hésitez ? Regardez la caméra : si elle a un cordon d’alimentation, elle est branchée.',
    differentOne: 'J’en ai une autre',
    stepsAgain: 'Revoir les étapes',
  },
  unsupported: {
    title: 'Celle-ci ne peut pas rejoindre Sightline',
    nothingWrong: 'Votre caméra n’a aucun problème, et vos autres caméras peuvent toujours être ici.',
    whatYouCanDo: 'Ce que vous pouvez faire',
  },
  system: {
    where: (brand: string) => `Où se trouve votre ${brand} ?`,
    body: 'Sightline peut le chercher sur votre Wi-Fi, pour que vous n’ayez pas à saisir son adresse.',
    typeAddress: 'Je saisis l’adresse',
  },
  connect: {
    title: (camera: string) => `Connecter votre ${camera.charAt(0).toLowerCase()}${camera.slice(1)}`,
    body: 'Juste l’adresse de la caméra et le compte que vous avez créé. Sightline s’occupe du reste.',
    noLink: (app: string) => `Aucun lien n’est encore copié. Dans l’app ${app}, touchez Copy à côté du lien, puis réessayez.`,
    ipCameras: 'Caméras IP',
    theCamera: 'la caméra',
    badAddress: 'Cette adresse ne semble pas correcte. Elle devrait ressembler à 192.168.1.50.',
    copiedFrom: (app: string) => `Vous avez copié le lien depuis l’app ${app} ?`,
    paste: 'Coller le lien',
    pastedWithAccount: 'Lien collé. Il contient déjà le nom d’utilisateur et le mot de passe.',
    pastedNoAccount: 'Lien collé. Ajoutez le nom d’utilisateur et le mot de passe ci-dessous.',
    address: 'Adresse de la caméra',
    addressHint: (app: string) => `Ou trouvez-la dans l’app ${app} : réglages de la caméra → Device info (ou Network). Elle ressemble à 192.168.1.50.`,
    username: 'Nom d’utilisateur',
    password: 'Mot de passe',
    name: 'Nom',
    namePlaceholder: 'Porte d’entrée',
    away: 'Y accéder hors de chez moi',
    awayDetail: 'Utilise votre propre VPN, si vous en avez configuré un (Réglages → Hors de chez vous).',
    showLink: 'Voir le lien qu’utilisera Sightline',
    addAnyway: 'L’ajouter quand même',
    connect: 'Connecter',
  },
};

export default guides;
