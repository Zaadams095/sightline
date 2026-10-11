import type en from '../en/ask.ts';
import { plural } from '../plural.ts';

const p = plural('pt-BR');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "à 1:05" / "às 15:42". */
const a = (time: string) => (/^0?1\D/.test(time) ? `à ${time}` : `às ${time}`);
/** "no sábado" / "na terça-feira". */
const onThe = (day: string) => (/^(sábado|domingo)/i.test(day) ? `no ${day}` : `na ${day}`);

const ask: typeof en = {
  screen: {
    title: 'Pergunte às suas câmeras',
    listening: 'Ouvindo…',
    questionLabel: 'Sua pergunta',
    stopListening: 'Parar de ouvir',
    speak: 'Fale sua pergunta',
    privacy: 'Respondido no seu iPhone. Nada sai do seu celular.',
    noSystems: 'Adicione suas câmeras primeiro e depois pergunte sobre o que elas viram.',
    liveOnly:
      'No momento, suas câmeras estão conectadas só para ver ao vivo. Para perguntar o que aconteceu, o Sightline precisa de um gravador ou câmera que guarde eventos, e de uma conexão com ele.',
    loadingIndex: 'Carregando suas gravações…',
    searching: 'Procurando nas suas gravações…',
    failed: (systems) => `Não foi possível carregar os eventos de ${systems}, então as respostas não os incluem.`,
    usedModel: 'Entendido com a Apple Intelligence, neste iPhone.',
    usedLocal: 'Entendido neste iPhone.',
    countNote: ' Cada gravação conta uma vez, então uma mesma visita pode contar mais de uma vez.',
    recordings: (n) => p(n, { one: `${n} gravação`, other: `${n} gravações` }),
    showingLatest: (n) => ` (mostrando as ${n} mais recentes)`,
    tryAsking: 'Experimente perguntar',
    examples: {
      package: 'Chegou alguma encomenda hoje?',
      backyard: 'Alguém esteve no quintal ontem à noite?',
      kids: 'Quando as crianças chegaram em casa?',
      cars: 'Quantos carros passaram nesta semana?',
      delivery: 'Mostre o entregador',
      door: 'Quem veio à porta hoje?',
    },
    rowLabel: (subject, camera, when) => `${subject} em ${camera}, ${when}. Reproduzir.`,
  },
  bar: {
    label: 'Faça uma pergunta às suas câmeras',
    hint: 'Pergunte às suas câmeras…',
    speak: 'Perguntar falando',
  },
  simple: {
    disabled:
      'Ative a Apple Intelligence em Ajustes para respostas mais inteligentes. Enquanto isso, o Sightline entende perguntas simples em inglês e as perguntas de exemplo.',
    notReady:
      'A Apple Intelligence ainda está sendo preparada neste iPhone. Enquanto isso, o Sightline entende perguntas simples em inglês e as perguntas de exemplo.',
    language:
      'A Apple Intelligence ainda não oferece suporte ao idioma do seu iPhone, então o Sightline entende perguntas simples em inglês e as perguntas de exemplo.',
    other:
      'Neste iPhone, o Sightline entende perguntas simples em inglês e as perguntas de exemplo. Com a Apple Intelligence (iOS 26 em um iPhone mais novo), ele entende muito mais.',
  },
  answer: {
    or: 'ou',
    one: {
      person: 'alguém',
      vehicle: 'um carro',
      package: 'uma encomenda',
      delivery: 'uma entrega',
      animal: 'um animal',
      bicycle: 'uma bicicleta',
      doorbell: 'alguém tocando a campainha',
    },
    many: {
      person: 'pessoas',
      vehicle: 'carros',
      package: 'encomendas',
      delivery: 'entregas',
      animal: 'animais',
      bicycle: 'bicicletas',
      doorbell: 'toques da campainha',
    },
    none: {
      person: 'ninguém',
      vehicle: 'nenhum carro',
      package: 'nenhuma encomenda',
      delivery: 'nenhuma entrega',
      animal: 'nenhum animal',
      bicycle: 'nenhuma bicicleta',
      doorbell: 'nenhum toque da campainha',
    },
    noneNames: (names) => names,
    nothing: 'nada',
    manyNames: (names) => names,
    events: 'atividade',
    labels: {
      person: 'alguém',
      face: 'alguém',
      car: 'um carro',
      truck: 'um caminhão',
      vehicle: 'um veículo',
      motorcycle: 'uma moto',
      bus: 'um ônibus',
      package: 'uma encomenda',
      dog: 'um cachorro',
      cat: 'um gato',
      bird: 'um pássaro',
      bicycle: 'uma bicicleta',
      doorbell: 'alguém tocando a campainha',
    },
    something: (label) => `algo (${label.toLowerCase()})`,
    motion: 'movimento',
    someoneUnknown: 'alguém que eu não reconheço',
    inZones: (zones) => ` na área ${zones}`,
    inZonesOn: (zones, cameras) => ` na área ${zones} em ${cameras}`,
    onCameras: (cameras) => ` em ${cameras}`,
    times: {
      'in the last few minutes': 'nos últimos minutos',
      'in the last hour': 'na última hora',
      today: 'hoje',
      'this morning': 'hoje de manhã',
      'this afternoon': 'hoje à tarde',
      'this evening': 'hoje à noite',
      'last night': 'ontem à noite',
      yesterday: 'ontem',
      'in the last 24 hours': 'nas últimas 24 horas',
      'this weekend': 'neste fim de semana',
      'this week': 'nesta semana',
      'last week': 'na semana passada',
      'in the past week': 'na última semana',
    },
    onDay: (day) => onThe(day),
    lastMinutes: (n) => p(n, { one: 'no último minuto', other: `nos últimos ${n} minutos` }),
    lastHours: (n) => p(n, { one: 'na última hora', other: `nas últimas ${n} horas` }),
    lastDays: (n) => p(n, { one: 'no último dia', other: `nos últimos ${n} dias` }),
    parts: {
      morning: ' de manhã',
      afternoon: ' à tarde',
      evening: ' à noite',
      night: ' de madrugada',
    },
    at: (time) => a(time),
    yesterdayAt: (time) => `ontem ${a(time)}`,
    onDayAt: (day, time) => `${onThe(day)} ${a(time)}`,
    describe: (subject, camera, time) => `${subject} em ${camera} ${time}`,
    yesNoNone: (what, where, when) => `Não, não vi ${what}${where} ${when}.`,
    yesNoNothing: (where, when) => `Não, nada foi gravado${where} ${when}.`,
    yesOne: (subject, camera, time) => `Sim. ${cap(subject)} apareceu em ${camera} ${time}.`,
    yesMany: (n, when, latest) => `Sim, ${n} vezes ${when}. A última: ${latest}.`,
    countNone: (what, where, when) => `Nenhuma vez. Não vi ${what}${where} ${when}.`,
    countSeen: (what, where, n, when, latest) =>
      `Vi ${what}${where} ${p(n, { one: 'uma vez', other: `${n} vezes` })} ${when}. A última: ${latest}.`,
    whenNone: (what, where, when) => `Não vi ${what}${where} ${when}.`,
    whenSeen: (subject, time, camera) => `${cap(subject)} apareceu ${time} em ${camera}.`,
    whenBefore: (times) => ` Antes disso: ${times}.`,
    whoNone: (where, when) => `Ninguém apareceu${where} ${when}.`,
    whoOne: (who, where, when) => `${cap(who)} apareceu${where} ${when}.`,
    whoMany: (who, where, when) => `${cap(who)} apareceram${where} ${when}.`,
    whoLatest: (latest) => ` A última vez: ${latest}.`,
    listNone: (what, where, when) => `Não encontrei ${what}${where} ${when}.`,
    listFound: (n, when, latest) => `${p(n, { one: 'Um resultado', other: `${n} resultados` })} ${when}. O mais recente: ${latest}.`,
  },
};

export default ask;
