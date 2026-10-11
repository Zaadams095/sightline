import type en from '../en/wall.ts';

const wall: typeof en = {
  display: {
    camera: 'Cámara',
    ring: 'Hay alguien en la puerta',
    tapToAnswer: (camera) => `${camera} · toca para contestar`,
    notReachable: (names) => `${names} sin conexión`,
    showControls: 'Mostrar los controles de la pantalla mural',
    connecting: 'Conectando con tus cámaras…',
    exit: 'Salir de la pantalla mural',
  },
  status: {
    noCameras: 'No hay cámaras',
    allConnected: 'todas conectadas',
    notConnected: (n) => `${n} sin conexión`,
  },
  settings: {
    title: 'Pantalla mural',
    intro: 'Convierte este iPad en una pared de cámaras siempre encendida: va pasando por tus cámaras, muestra el timbre cuando alguien llama y se atenúa por la noche.',
    start: 'Iniciar pantalla mural',
    showCameras: 'Mostrar cámaras',
    grid: 'Todas a la vez (cuadrícula)',
    single: 'Una a una',
    gridEvery: 'Si hay más cámaras de las que caben, la siguiente pantalla aparece cada',
    singleEvery: 'Siguiente cámara cada',
    camerasOnWall: 'Cámaras en la pantalla',
    allCameras: 'Todas las cámaras',
    whenSomething: 'Cuando pasa algo',
    whenFooter: 'Los avisos siguen tus ajustes de avisos. Al rato, la pantalla vuelve al recorrido.',
    showDoorbell: 'Mostrar el timbre cuando alguien llama',
    showAlert: 'Mostrar la cámara con un aviso nuevo',
    night: 'Noche',
    dimAtNight: 'Atenuar por la noche',
    from: 'Desde',
    until: 'Hasta',
    levels: {
      little: 'Un poco',
      more: 'Más',
      most: 'Al máximo',
    },
    clock: 'Reloj y fecha',
    tablet: 'Para una tableta en la pared',
    tipPower: '• Déjala enchufada. La pantalla se queda encendida mientras la pantalla mural está abierta.',
    tipGuided:
      '• Para que se quede en Sightline: Ajustes → Accesibilidad → Acceso Guiado, actívalo, abre la pantalla mural y pulsa el botón superior tres veces.',
    tipBurnIn: '• Para proteger la pantalla, la imagen se mueve un poquito cada minuto y las cámaras cambian de sitio cada 15 minutos.',
    tipLeave: '• Toca la pantalla para salir. Si la app está bloqueada, hará falta Face ID o tu PIN.',
  },
};

export default wall;
