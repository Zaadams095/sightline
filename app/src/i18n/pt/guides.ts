import type en from '../en/guides.ts';
import { plural } from '../plural.ts';

const p = plural('pt-BR');

// Menu names inside each brand's own app stay in English, as in en/guides.ts.
const guides: typeof en = {
  comeBack: 'Volte aqui e toque em Avançar.',
  badAddress: 'Isso não parece o endereço de uma câmera. Deve ser parecido com 192.168.1.50.',
  alt: {
    pickAnother: 'Escolher outra marca',
    findOnWifi: 'Procurar câmeras no meu Wi-Fi',
    haveLink: 'Tenho um link de vídeo (rtsp://…)',
    seeWorking: 'Ver câmeras que funcionam com o Sightline',
  },
  groups: {
    camera: 'Câmeras Wi-Fi',
    recorder: 'Câmeras com gravador e marcas profissionais',
    cloud: 'Câmeras só na nuvem',
  },
  apps: {
    amcrest: 'Amcrest Smart Home ou Amcrest View Pro',
    lorex: 'Lorex Home ou Lorex Cloud',
  },
  tapo: {
    plugin: {
      title: 'Câmera na tomada',
      detail: 'A maioria das câmeras Tapo com cabo de energia',
      steps: [
        'Abra o app Tapo e toque na sua câmera.',
        'Toque na engrenagem no canto superior direito e depois em Advanced Settings → Camera Account.',
        'Toque em “Understand and Agree to Use”. Crie um usuário e uma senha (de 6 a 32 caracteres cada) e anote. Eles são só da câmera, não do seu login da Tapo.',
      ],
      usernameLabel: 'Usuário da conta da câmera',
      usernameHint: 'O usuário que você acabou de criar no app Tapo.',
      passwordLabel: 'Senha da conta da câmera',
      passwordHint: 'Não é a senha do seu login da Tapo.',
      cameraName: 'Câmera Tapo',
    },
    battery: {
      title: 'Câmera a bateria ou campainha',
      detail: 'Como a C400, C420, C425 ou uma campainha a bateria',
      why: 'As câmeras Tapo a bateria dormem entre as gravações para economizar energia, então só enviam vídeo para o app Tapo. O Sightline não consegue mostrá-las, mas funciona com câmeras Tapo ligadas na tomada.',
      usePlugin: 'Configurar uma câmera Tapo na tomada',
    },
  },
  wyze: {
    v3: {
      title: 'Wyze Cam v3 ou Pan v3',
      detail: 'Com a atualização mais recente da câmera',
      steps: [
        'Atualize o app Wyze e depois a câmera (ajustes da câmera → Device Info → Firmware).',
        'Nos ajustes da câmera, toque em Advanced Settings → RTSP e ative.',
        'Crie um usuário e uma senha (de 4 a 10 letras ou números) e toque em Generate URL.',
        'Toque em Copy para copiar o link que aparece.',
      ],
      usernameLabel: 'Usuário RTSP',
      usernameHint: 'O usuário que você acabou de criar no app Wyze.',
      passwordLabel: 'Senha RTSP',
      cameraName: 'Câmera Wyze',
    },
    other: {
      title: 'Wyze Cam v4, OG, campainha ou câmera a bateria',
      why: 'Por enquanto, essas câmeras Wyze só enviam vídeo para o app Wyze. A Wyze disse que uma opção de vídeo está chegando para a Cam v4, mas ainda não saiu. Quando chegar, volte e escolha “Wyze Cam v3 ou Pan v3”: os passos são os mesmos.',
    },
  },
  eufy: {
    rtsp: {
      title: 'Câmera com “NAS (RTSP)”',
      detail: 'A maioria das câmeras eufy na tomada',
      steps: [
        'Abra o app eufy Security, toque na sua câmera e depois na engrenagem para ver os ajustes.',
        'Procure Storage → NAS (RTSP) e ative. Se não aparecer, essa câmera não consegue compartilhar vídeo (veja “Outras câmeras eufy”).',
        'Escolha “Continuous” para ter vídeo sempre, crie um usuário e uma senha e copie o link que aparece.',
      ],
      usernameLabel: 'Usuário RTSP',
      usernameHint: 'O usuário da tela NAS (RTSP) no app eufy.',
      passwordLabel: 'Senha RTSP',
      cameraName: 'Câmera eufy',
    },
    other: {
      title: 'Outras câmeras eufy',
      detail: 'Sem “NAS (RTSP)” no app',
      why: 'Algumas câmeras eufy, principalmente as a bateria, só enviam vídeo para o app eufy. Se o app não tiver o ajuste “NAS (RTSP)” para a câmera, o Sightline não consegue mostrá-la.',
      checkAgain: 'Procurar “NAS (RTSP)” de novo',
    },
  },
  imou: {
    camera: {
      title: 'Câmera Imou',
      detail: 'A maioria dos modelos na tomada',
      steps: [
        'Encontre a etiqueta na câmera (geralmente embaixo). Procure “Safety code” ou “SC”, um código curto de letras e números.',
        'Tire uma foto ou anote exatamente como está. Letras maiúsculas fazem diferença.',
      ],
      usernameHint: 'As câmeras Imou usam “admin”.',
      passwordLabel: 'Código de segurança',
      passwordHint: 'O código da etiqueta, mesmo que você tenha mudado a senha no app Imou.',
      cameraName: 'Câmera Imou',
    },
  },
  ezviz: {
    camera: {
      title: 'Câmera EZVIZ',
      detail: 'Muitos modelos na tomada',
      steps: [
        'Encontre a etiqueta na câmera e anote o “Verification code” de 6 letras. Letras maiúsculas fazem diferença.',
        'No app EZVIZ, toque no seu perfil → Settings → LAN Live View → Start Scanning e escolha sua câmera.',
        'Toque na engrenagem → Local Server Settings e ative o RTSP. Se não houver a chave de RTSP, essa câmera não consegue compartilhar vídeo.',
      ],
      usernameHint: 'As câmeras EZVIZ usam “admin”.',
      passwordLabel: 'Código de verificação',
      passwordHint: 'O código da etiqueta da câmera.',
      cameraName: 'Câmera EZVIZ',
    },
  },
  kasa: {
    all: {
      title: 'Câmera Kasa',
      why: 'As câmeras Kasa só enviam vídeo para o app Kasa, então o Sightline não consegue mostrá-las. As câmeras Tapo da TP-Link (a mesma empresa) funcionam com o Sightline.',
      useTapo: 'Configurar uma câmera Tapo',
    },
  },
  reolink: {
    wired: {
      title: 'Câmera na tomada, gravador ou Home Hub',
      detail: 'Qualquer coisa com cabo de energia, um gravador ou um Home Hub',
      steps: [
        'Tenha sua senha da Reolink em mãos (a da câmera ou do gravador no app Reolink).',
        'Se você tem um gravador ou Home Hub, use-o: todas as câmeras ligadas a ele aparecem no Sightline, até as a bateria.',
      ],
    },
    battery: {
      title: 'Câmera a bateria sozinha',
      detail: 'Argus, Altas, campainha a bateria, sem Home Hub',
      why: 'As câmeras Reolink a bateria dormem para economizar energia, então sozinhas só falam com o app Reolink. Ligadas a um Home Hub ou gravador Reolink, elas funcionam no Sightline.',
      haveHub: 'Tenho um Home Hub ou gravador',
    },
    lte: {
      title: 'Câmera 4G / LTE (com chip SIM)',
      why: 'As câmeras 4G da Reolink usam a rede celular em vez do Wi-Fi da sua casa, então só o app Reolink consegue acessá-las.',
    },
  },
  amcrest: {
    all: {
      title: 'Câmera ou gravador Amcrest',
      steps: [
        'Tenha em mãos a senha de admin da câmera (ou do gravador), a que você criou na primeira configuração.',
        'Se suas câmeras estão em um gravador, use o endereço do gravador: todas as câmeras dele aparecem de uma vez.',
      ],
    },
  },
  lorex: {
    recorder: {
      title: 'Gravador (uma caixa onde suas câmeras se conectam)',
      detail: 'A maioria dos kits NVR e DVR da Lorex',
      steps: [
        'Na tela do gravador, abra Main Menu → Network para ver o endereço IP, ou veja Device info no app Lorex.',
        'Tenha em mãos a senha de admin do gravador (a que você usa na tela do gravador).',
      ],
    },
    wifi: {
      title: 'Câmera Wi-Fi ou a bateria sem gravador',
      detail: 'Configurada só no app Lorex Home',
      why: 'A maioria das câmeras Lorex Wi-Fi e a bateria sem gravador só envia vídeo para o app Lorex. Se a sua está ligada a um gravador Lorex, adicione o gravador e ela vai aparecer.',
      onRecorder: 'Está em um gravador Lorex',
    },
  },
  swann: {
    recorder: {
      title: 'Gravador (uma caixa onde suas câmeras se conectam)',
      detail: 'A maioria dos kits NVR e DVR da Swann',
      steps: [
        'Na tela do gravador, abra o menu → Network para ver o endereço IP.',
        'Tenha em mãos a senha de admin do gravador (a que você usa na tela do gravador).',
      ],
    },
    wifi: {
      title: 'Câmera Wi-Fi ou a bateria sem gravador',
      why: 'As câmeras Wi-Fi e a bateria da Swann só enviam vídeo para o app Swann Security, então o Sightline não consegue mostrá-las.',
      haveRecorder: 'Tenho um gravador Swann',
    },
  },
  annke: {
    all: {
      title: 'Câmera ou gravador Annke',
      steps: [
        'Tenha em mãos a senha de admin, a que você criou na primeira configuração da câmera ou do gravador.',
        'Se suas câmeras estão em um gravador, use o gravador: todas as câmeras dele aparecem de uma vez.',
      ],
    },
  },
  hikvision: {
    all: {
      title: 'Câmera ou gravador Hikvision',
      detail: 'Também HiWatch, LTS e outras marcas fabricadas pela Hikvision',
      steps: ['Tenha em mãos a senha de admin, a que você usa para entrar no gravador (não sua conta Hik-Connect).'],
    },
  },
  dahua: {
    all: {
      title: 'Câmera ou gravador Dahua',
      steps: ['Tenha em mãos a senha de admin, a que você usa na tela do gravador.'],
    },
  },
  ubiquiti: {
    all: {
      steps: [
        'Em um computador, abra seu console UniFi e vá em Admins & Users → adicione um novo admin.',
        'Escolha “Restrict to local access only”, dê acesso ao Protect e crie um usuário e uma senha.',
      ],
    },
  },
  cloudWhy: {
    ring: 'As câmeras Ring enviam vídeo só para a nuvem da Ring, e a Ring não deixa outros apps assistirem. É uma escolha da Ring, não um problema da sua câmera. Continue usando o app Ring para elas.',
    nest: 'As câmeras Nest enviam vídeo só para a nuvem do Google. O Google não oferece um jeito de apps como o Sightline mostrá-las na sua rede de casa. Continue usando o app Google Home para elas.',
    arlo: 'As câmeras Arlo enviam vídeo só para a nuvem da Arlo, então o Sightline não consegue mostrá-las. Continue usando o app Arlo para elas.',
    blink: 'As câmeras Blink enviam vídeo só para a nuvem da Blink, então o Sightline não consegue mostrá-las. Continue usando o app Blink para elas.',
    simplisafe:
      'As câmeras SimpliSafe fazem parte do sistema próprio da SimpliSafe e não compartilham vídeo com outros apps. Continue usando o app SimpliSafe para elas.',
  },

  parts: {
    stepOf: (step: number, total: number, label: string) => `Passo ${step} de ${total} · ${label}`,
    stepOfA11y: (step: number, total: number, label: string) => `Passo ${step} de ${total}: ${label}`,
    titleDetail: (title: string, detail: string) => `${title}. ${detail}`,
    starting: 'Começando…',
    findIt: 'Procurar no meu Wi-Fi',
    looking: 'Procurando…',
    lookingDetail: (status: string) => `${status} Se o seu celular pedir para encontrar dispositivos na sua rede, toque em Permitir.`,
    notFound: 'Não encontramos. Verifique se a câmera está ligada e se o celular está no mesmo Wi-Fi, ou digite o endereço abaixo.',
    found: (n: number) => p(n, { one: 'Encontramos uma. É esta?', other: `Encontramos ${n}. Toque na que você está configurando.` }),
    lookAgain: 'Procurar de novo',
  },

  screen: {
    missingTitle: 'Vamos tentar de outro jeito',
    missingBody: 'Esse guia não está disponível. Escolha sua marca de novo ou deixe o Sightline procurar suas câmeras.',
    pickBrand: 'Escolher minha marca',
    findOnWifi: 'Procurar câmeras no meu Wi-Fi',
    stageWhich: 'Qual câmera',
    stageReady: 'Preparar',
    stageConnect: 'Conectar',
    whichOne: (brand: string) => `Qual modelo de ${brand} você tem?`,
    notSure: 'Não tem certeza? Olhe a câmera: se ela tem cabo de energia, está na tomada.',
    differentOne: 'Tenho outro modelo',
    stepsAgain: 'Ver os passos de novo',
  },
  unsupported: {
    title: 'Esta não pode entrar no Sightline',
    nothingWrong: 'Não há nada de errado com sua câmera, e suas outras câmeras podem continuar aqui.',
    whatYouCanDo: 'O que você pode fazer',
  },
  system: {
    where: (brand: string) => `Onde está seu ${brand}?`,
    body: 'O Sightline pode procurar no Wi-Fi da sua casa, para você não precisar digitar o endereço.',
    typeAddress: 'Vou digitar o endereço',
  },
  connect: {
    title: (camera: string) => `Conecte sua ${camera.charAt(0).toLowerCase()}${camera.slice(1)}`,
    body: 'Só o endereço da câmera e a conta que você criou. O Sightline faz o resto.',
    noLink: (app: string) => `Ainda não há nenhum link copiado. No app ${app}, toque em Copy ao lado do link e tente de novo.`,
    ipCameras: 'Câmeras IP',
    theCamera: 'a câmera',
    badAddress: 'Esse endereço não parece certo. Deve ser parecido com 192.168.1.50.',
    copiedFrom: (app: string) => `Copiou o link do app ${app}?`,
    paste: 'Colar o link',
    pastedWithAccount: 'Link colado. Ele já tem o usuário e a senha.',
    pastedNoAccount: 'Link colado. Adicione o usuário e a senha abaixo.',
    address: 'Endereço da câmera',
    addressHint: (app: string) => `Ou encontre no app ${app}: ajustes da câmera → Device info (ou Network). É parecido com 192.168.1.50.`,
    username: 'Usuário',
    password: 'Senha',
    name: 'Nome',
    namePlaceholder: 'Porta da frente',
    away: 'Ver quando eu estiver fora',
    awayDetail: 'Usa sua própria VPN, se você configurou uma (Ajustes → Fora de casa).',
    showLink: 'Ver o link que o Sightline vai usar',
    addAnyway: 'Adicionar mesmo assim',
    connect: 'Conectar',
  },
};

export default guides;
