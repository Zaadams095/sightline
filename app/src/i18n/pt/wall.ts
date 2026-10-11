import type en from '../en/wall.ts';

const wall: typeof en = {
  display: {
    camera: 'Câmera',
    ring: 'Tem alguém na porta',
    tapToAnswer: (camera) => `${camera} · toque para atender`,
    notReachable: (names) => `${names} fora de alcance`,
    showControls: 'Mostrar os controles da tela de parede',
    connecting: 'Conectando às suas câmeras…',
    exit: 'Sair da tela de parede',
  },
  status: {
    noCameras: 'Nenhuma câmera',
    allConnected: 'todas conectadas',
    notConnected: (n) => `${n} sem conexão`,
  },
  settings: {
    title: 'Tela de parede',
    intro: 'Transforma este iPad em uma parede de câmeras sempre ligada: ele passa pelas suas câmeras, mostra a campainha quando alguém toca e escurece à noite.',
    start: 'Iniciar tela de parede',
    showCameras: 'Mostrar câmeras',
    grid: 'Todas juntas (grade)',
    single: 'Uma de cada vez',
    gridEvery: 'Se houver mais câmeras do que cabem, a próxima tela aparece a cada',
    singleEvery: 'Próxima câmera a cada',
    camerasOnWall: 'Câmeras na parede',
    allCameras: 'Todas as câmeras',
    whenSomething: 'Quando algo acontece',
    whenFooter: 'Os alertas seguem seus ajustes de alertas. Depois de um tempo, a parede volta ao rodízio.',
    showDoorbell: 'Mostrar a campainha quando alguém tocar',
    showAlert: 'Mostrar a câmera com um alerta novo',
    night: 'Noite',
    dimAtNight: 'Escurecer à noite',
    from: 'De',
    until: 'Até',
    levels: {
      little: 'Um pouco',
      more: 'Mais',
      most: 'Bastante',
    },
    clock: 'Relógio e data',
    tablet: 'Para um tablet na parede',
    tipPower: '• Deixe na tomada. A tela fica ligada enquanto a tela de parede estiver aberta.',
    tipGuided:
      '• Para manter no Sightline: Ajustes → Acessibilidade → Acesso Guiado, ative, depois abra a tela de parede e aperte o botão superior três vezes.',
    tipBurnIn: '• Para proteger a tela, a imagem se move um pouquinho a cada minuto e as câmeras trocam de lugar a cada 15 minutos.',
    tipLeave: '• Toque na tela para sair. Se o app estiver bloqueado, vai pedir Face ID ou seu PIN.',
  },
};

export default wall;
