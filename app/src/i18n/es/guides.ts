import type en from '../en/guides.ts';
import { plural } from '../plural.ts';

const p = plural('es');

// Menu names inside each brand's own app stay in English, as in en/guides.ts.
const guides: typeof en = {
  comeBack: 'Vuelve aquí y toca Siguiente.',
  badAddress: 'Eso no parece la dirección de una cámara. Debería verse así: 192.168.1.50.',
  alt: {
    pickAnother: 'Elegir otra marca',
    findOnWifi: 'Buscar cámaras en mi Wi-Fi',
    haveLink: 'Tengo un enlace de vídeo (rtsp://…)',
    seeWorking: 'Ver cámaras que funcionan con Sightline',
  },
  groups: {
    camera: 'Cámaras Wi-Fi',
    recorder: 'Cámaras con grabador y marcas profesionales',
    cloud: 'Cámaras solo en la nube',
  },
  apps: {
    amcrest: 'Amcrest Smart Home o Amcrest View Pro',
    lorex: 'Lorex Home o Lorex Cloud',
  },
  tapo: {
    plugin: {
      title: 'Cámara enchufada',
      detail: 'La mayoría de las cámaras Tapo con cable de corriente',
      steps: [
        'Abre la app Tapo y toca tu cámara.',
        'Toca el engranaje arriba a la derecha y luego Advanced Settings → Camera Account.',
        'Toca «Understand and Agree to Use». Crea un usuario y una contraseña (de 6 a 32 caracteres cada uno) y anótalos. Son solo para la cámara, no tu cuenta de Tapo.',
      ],
      usernameLabel: 'Usuario de la cuenta de la cámara',
      usernameHint: 'El usuario que acabas de crear en la app Tapo.',
      passwordLabel: 'Contraseña de la cuenta de la cámara',
      passwordHint: 'No es la contraseña de tu cuenta de Tapo.',
      cameraName: 'Cámara Tapo',
    },
    battery: {
      title: 'Cámara de batería o timbre',
      detail: 'Como la C400, C420, C425 o un timbre de batería',
      why: 'Las cámaras Tapo de batería duermen entre grabaciones para ahorrar energía, así que solo envían vídeo a la app Tapo. Sightline no puede mostrarlas, pero sí funciona con las cámaras Tapo que se enchufan a la pared.',
      usePlugin: 'Configurar una cámara Tapo enchufada',
    },
  },
  wyze: {
    v3: {
      title: 'Wyze Cam v3 o Pan v3',
      detail: 'Con la última actualización de la cámara',
      steps: [
        'Actualiza la app Wyze y luego la cámara (ajustes de la cámara → Device Info → Firmware).',
        'En los ajustes de la cámara, toca Advanced Settings → RTSP y actívalo.',
        'Crea un usuario y una contraseña (de 4 a 10 letras o números) y toca Generate URL.',
        'Toca Copy para copiar el enlace que aparece.',
      ],
      usernameLabel: 'Usuario RTSP',
      usernameHint: 'El usuario que acabas de crear en la app Wyze.',
      passwordLabel: 'Contraseña RTSP',
      cameraName: 'Cámara Wyze',
    },
    other: {
      title: 'Wyze Cam v4, OG, timbre o cámara de batería',
      why: 'Por ahora, estas cámaras Wyze solo envían vídeo a la app Wyze. Wyze ha dicho que llegará una opción de vídeo para la Cam v4, pero aún no está disponible. Cuando llegue, vuelve y elige «Wyze Cam v3 o Pan v3»: los pasos son los mismos.',
    },
  },
  eufy: {
    rtsp: {
      title: 'Cámara con «NAS (RTSP)»',
      detail: 'La mayoría de las cámaras eufy enchufadas',
      steps: [
        'Abre la app eufy Security, toca tu cámara y luego el engranaje para ver sus ajustes.',
        'Busca Storage → NAS (RTSP) y actívalo. Si no lo ves, esta cámara no puede compartir vídeo (mira «Otras cámaras eufy»).',
        'Elige «Continuous» para que siempre haya vídeo, crea un usuario y una contraseña, y copia el enlace que aparece.',
      ],
      usernameLabel: 'Usuario RTSP',
      usernameHint: 'El usuario de la pantalla NAS (RTSP) en la app eufy.',
      passwordLabel: 'Contraseña RTSP',
      cameraName: 'Cámara eufy',
    },
    other: {
      title: 'Otras cámaras eufy',
      detail: 'Sin «NAS (RTSP)» en la app',
      why: 'Algunas cámaras eufy, sobre todo las de batería, solo envían vídeo a la app eufy. Si la app no tiene el ajuste «NAS (RTSP)» para la cámara, Sightline no puede mostrarla.',
      checkAgain: 'Volver a buscar «NAS (RTSP)»',
    },
  },
  imou: {
    camera: {
      title: 'Cámara Imou',
      detail: 'La mayoría de los modelos enchufados',
      steps: [
        'Busca la etiqueta de la cámara (suele estar debajo). Busca «Safety code» o «SC», un código corto de letras y números.',
        'Hazle una foto o anótalo tal cual. Las mayúsculas importan.',
      ],
      usernameHint: 'Las cámaras Imou usan «admin».',
      passwordLabel: 'Código de seguridad',
      passwordHint: 'El código de la etiqueta, aunque hayas cambiado la contraseña en la app Imou.',
      cameraName: 'Cámara Imou',
    },
  },
  ezviz: {
    camera: {
      title: 'Cámara EZVIZ',
      detail: 'Muchos modelos enchufados',
      steps: [
        'Busca la etiqueta de la cámara y anota el «Verification code» de 6 letras. Las mayúsculas importan.',
        'En la app EZVIZ, toca tu perfil → Settings → LAN Live View → Start Scanning, y elige tu cámara.',
        'Toca el engranaje → Local Server Settings y activa RTSP. Si no hay interruptor de RTSP, esta cámara no puede compartir vídeo.',
      ],
      usernameHint: 'Las cámaras EZVIZ usan «admin».',
      passwordLabel: 'Código de verificación',
      passwordHint: 'El código de la etiqueta de la cámara.',
      cameraName: 'Cámara EZVIZ',
    },
  },
  kasa: {
    all: {
      title: 'Cámara Kasa',
      why: 'Las cámaras Kasa solo envían vídeo a la app Kasa, así que Sightline no puede mostrarlas. Las cámaras Tapo de TP-Link (la misma empresa) sí funcionan con Sightline.',
      useTapo: 'Configurar una cámara Tapo',
    },
  },
  reolink: {
    wired: {
      title: 'Cámara enchufada, grabador o Home Hub',
      detail: 'Cualquier cosa con cable de corriente, un grabador o un Home Hub',
      steps: [
        'Ten a mano tu contraseña de Reolink (la de la cámara o el grabador en la app Reolink).',
        'Si tienes un grabador o un Home Hub, úsalo: todas sus cámaras aparecerán en Sightline, también las de batería.',
      ],
    },
    battery: {
      title: 'Cámara de batería sola',
      detail: 'Argus, Altas, timbre de batería, sin Home Hub',
      why: 'Las cámaras Reolink de batería duermen para ahorrar energía, así que solas solo hablan con la app Reolink. Conectadas a un Home Hub o grabador de Reolink, funcionan en Sightline.',
      haveHub: 'Tengo un Home Hub o un grabador',
    },
    lte: {
      title: 'Cámara 4G / LTE (con tarjeta SIM)',
      why: 'Las cámaras 4G de Reolink usan la red móvil en vez del Wi-Fi de tu casa, así que solo la app Reolink puede llegar a ellas.',
    },
  },
  amcrest: {
    all: {
      title: 'Cámara o grabador Amcrest',
      steps: [
        'Ten a mano la contraseña de admin de la cámara (o del grabador), la que creaste al configurarla por primera vez.',
        'Si tus cámaras están en un grabador, usa la dirección del grabador: todas sus cámaras aparecen a la vez.',
      ],
    },
  },
  lorex: {
    recorder: {
      title: 'Grabador (una caja a la que se conectan tus cámaras)',
      detail: 'La mayoría de los kits NVR y DVR de Lorex',
      steps: [
        'En la pantalla del grabador, abre Main Menu → Network para ver su dirección IP, o mira Device info en la app Lorex.',
        'Ten a mano la contraseña de admin del grabador (la que usas en la pantalla del grabador).',
      ],
    },
    wifi: {
      title: 'Cámara Wi-Fi o de batería sin grabador',
      detail: 'Configurada solo en la app Lorex Home',
      why: 'La mayoría de las cámaras Lorex Wi-Fi y de batería sin grabador solo envían vídeo a la app Lorex. Si la tuya está conectada a un grabador Lorex, añade el grabador y aparecerá.',
      onRecorder: 'Está en un grabador Lorex',
    },
  },
  swann: {
    recorder: {
      title: 'Grabador (una caja a la que se conectan tus cámaras)',
      detail: 'La mayoría de los kits NVR y DVR de Swann',
      steps: [
        'En la pantalla del grabador, abre el menú → Network para ver su dirección IP.',
        'Ten a mano la contraseña de admin del grabador (la que usas en la pantalla del grabador).',
      ],
    },
    wifi: {
      title: 'Cámara Wi-Fi o de batería sin grabador',
      why: 'Las cámaras Wi-Fi y de batería de Swann solo envían vídeo a la app Swann Security, así que Sightline no puede mostrarlas.',
      haveRecorder: 'Tengo un grabador Swann',
    },
  },
  annke: {
    all: {
      title: 'Cámara o grabador Annke',
      steps: [
        'Ten a mano la contraseña de admin, la que creaste al configurar la cámara o el grabador por primera vez.',
        'Si tus cámaras están en un grabador, usa el grabador: todas sus cámaras aparecen a la vez.',
      ],
    },
  },
  hikvision: {
    all: {
      title: 'Cámara o grabador Hikvision',
      detail: 'También HiWatch, LTS y otras marcas fabricadas por Hikvision',
      steps: ['Ten a mano la contraseña de admin, la que usas para entrar al grabador (no tu cuenta de Hik-Connect).'],
    },
  },
  dahua: {
    all: {
      title: 'Cámara o grabador Dahua',
      steps: ['Ten a mano la contraseña de admin, la que usas en la pantalla del grabador.'],
    },
  },
  ubiquiti: {
    all: {
      steps: [
        'En un ordenador, abre tu consola UniFi y ve a Admins & Users → añade un nuevo admin.',
        'Elige «Restrict to local access only», dale acceso a Protect y crea un usuario y una contraseña.',
      ],
    },
  },
  cloudWhy: {
    ring: 'Las cámaras Ring envían vídeo solo a la nube de Ring, y Ring no deja que otras apps las vean. Es decisión de Ring, no un problema de tu cámara. Sigue usando la app Ring para estas.',
    nest: 'Las cámaras Nest envían vídeo solo a la nube de Google. Google no ofrece una forma para que apps como Sightline las muestren en tu red de casa. Sigue usando la app Google Home para estas.',
    arlo: 'Las cámaras Arlo envían vídeo solo a la nube de Arlo, así que Sightline no puede mostrarlas. Sigue usando la app Arlo para estas.',
    blink: 'Las cámaras Blink envían vídeo solo a la nube de Blink, así que Sightline no puede mostrarlas. Sigue usando la app Blink para estas.',
    simplisafe:
      'Las cámaras SimpliSafe son parte del sistema propio de SimpliSafe y no comparten vídeo con otras apps. Sigue usando la app SimpliSafe para estas.',
  },

  parts: {
    stepOf: (step: number, total: number, label: string) => `Paso ${step} de ${total} · ${label}`,
    stepOfA11y: (step: number, total: number, label: string) => `Paso ${step} de ${total}: ${label}`,
    titleDetail: (title: string, detail: string) => `${title}. ${detail}`,
    starting: 'Empezando…',
    findIt: 'Buscarla en mi Wi-Fi',
    looking: 'Buscándola…',
    lookingDetail: (status: string) => `${status} Si tu teléfono pide permiso para buscar dispositivos en tu red, toca Permitir.`,
    notFound: 'No la encontramos. Asegúrate de que la cámara esté encendida y tu teléfono en el mismo Wi-Fi, o escribe su dirección abajo.',
    found: (n: number) => p(n, { one: 'Encontramos una. ¿Es esta?', other: `Encontramos ${n}. Toca la que estás configurando.` }),
    lookAgain: 'Buscar de nuevo',
  },

  screen: {
    missingTitle: 'Probemos de otra forma',
    missingBody: 'Esa guía no está disponible. Vuelve a elegir tu marca o deja que Sightline busque tus cámaras.',
    pickBrand: 'Elegir mi marca',
    findOnWifi: 'Buscar cámaras en mi Wi-Fi',
    stageWhich: 'Qué cámara',
    stageReady: 'Prepárate',
    stageConnect: 'Conectar',
    whichOne: (brand: string) => `¿Qué modelo de ${brand} tienes?`,
    notSure: '¿No estás seguro? Mira la cámara: si tiene cable de corriente, está enchufada.',
    differentOne: 'Tengo otra distinta',
    stepsAgain: 'Ver los pasos otra vez',
  },
  unsupported: {
    title: 'Esta no puede unirse a Sightline',
    nothingWrong: 'Tu cámara no tiene ningún problema, y tus otras cámaras pueden seguir aquí.',
    whatYouCanDo: 'Lo que puedes hacer',
  },
  system: {
    where: (brand: string) => `¿Dónde está tu ${brand}?`,
    body: 'Sightline puede buscarlo en el Wi-Fi de tu casa para que no tengas que escribir su dirección.',
    typeAddress: 'Escribiré la dirección',
  },
  connect: {
    title: (camera: string) => `Conecta tu ${camera.charAt(0).toLowerCase()}${camera.slice(1)}`,
    body: 'Solo la dirección de la cámara y la cuenta que creaste. Sightline hace el resto.',
    noLink: (app: string) => `Aún no hay ningún enlace copiado. En la app ${app}, toca Copy junto al enlace y vuelve a intentarlo.`,
    ipCameras: 'Cámaras IP',
    theCamera: 'la cámara',
    badAddress: 'Esa dirección no parece correcta. Debería verse así: 192.168.1.50.',
    copiedFrom: (app: string) => `¿Copiaste el enlace de la app ${app}?`,
    paste: 'Pegar el enlace',
    pastedWithAccount: 'Enlace pegado. Ya incluye el usuario y la contraseña.',
    pastedNoAccount: 'Enlace pegado. Añade el usuario y la contraseña abajo.',
    address: 'Dirección de la cámara',
    addressHint: (app: string) => `O búscala en la app ${app}: ajustes de la cámara → Device info (o Network). Se ve así: 192.168.1.50.`,
    username: 'Usuario',
    password: 'Contraseña',
    name: 'Nombre',
    namePlaceholder: 'Puerta principal',
    away: 'Conectar cuando esté fuera',
    awayDetail: 'Usa tu propia VPN, si configuraste una (Ajustes → Fuera de casa).',
    showLink: 'Ver el enlace que usará Sightline',
    addAnyway: 'Añadirla de todos modos',
    connect: 'Conectar',
  },
};

export default guides;
