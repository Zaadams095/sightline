import type en from '../en/wall.ts';

const wall: typeof en = {
  display: {
    camera: 'Caméra',
    ring: 'Quelqu’un sonne à la porte',
    tapToAnswer: (camera) => `${camera} · touchez pour répondre`,
    notReachable: (names) => `${names} injoignable`,
    showControls: 'Afficher les commandes de l’écran mural',
    connecting: 'Connexion à vos caméras…',
    exit: 'Quitter l’écran mural',
  },
  status: {
    noCameras: 'Aucune caméra',
    allConnected: 'toutes connectées',
    notConnected: (n) => `${n} hors ligne`,
  },
  settings: {
    title: 'Écran mural',
    intro: 'Transforme cet iPad en mur de caméras toujours allumé : il passe d’une caméra à l’autre, montre la sonnette quand quelqu’un sonne et baisse la luminosité la nuit.',
    start: 'Lancer l’écran mural',
    showCameras: 'Afficher les caméras',
    grid: 'Toutes en même temps (grille)',
    single: 'Une par une',
    gridEvery: 'S’il y a plus de caméras que de place, l’écran suivant s’affiche toutes les',
    singleEvery: 'Caméra suivante toutes les',
    camerasOnWall: 'Caméras sur l’écran',
    allCameras: 'Toutes les caméras',
    whenSomething: 'Quand il se passe quelque chose',
    whenFooter: 'Les alertes suivent vos réglages d’alerte. Après un moment, l’écran reprend la visite.',
    showDoorbell: 'Montrer la sonnette quand quelqu’un sonne',
    showAlert: 'Montrer une caméra avec une nouvelle alerte',
    night: 'Nuit',
    dimAtNight: 'Assombrir la nuit',
    from: 'De',
    until: 'À',
    levels: {
      little: 'Un peu',
      more: 'Plus',
      most: 'Au maximum',
    },
    clock: 'Heure et date',
    tablet: 'Pour une tablette au mur',
    tipPower: '• Gardez-la branchée. L’écran reste allumé tant que l’écran mural est ouvert.',
    tipGuided:
      '• Pour rester sur Sightline : Réglages → Accessibilité → Accès guidé, activez-le, puis ouvrez l’écran mural et appuyez trois fois sur le bouton du haut.',
    tipBurnIn: '• Pour protéger l’écran, l’image se décale très légèrement chaque minute et les caméras changent de place toutes les 15 minutes.',
    tipLeave: '• Touchez l’écran pour quitter. Si l’app est verrouillée, Face ID ou votre code PIN sera demandé.',
  },
};

export default wall;
