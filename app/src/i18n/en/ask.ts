import { plural } from '../plural.ts';

const p = plural('en');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Ask your cameras": the screen, the Recordings search bar, and the spoken answers (ask/engine.ts). */
const ask = {
  // app/ask.tsx
  screen: {
    title: 'Ask your cameras',
    listening: 'Listening…',
    questionLabel: 'Your question',
    stopListening: 'Stop listening',
    speak: 'Speak your question',
    privacy: 'Answered on your iPhone. Nothing leaves your phone.',
    noSystems: 'Add your cameras first, then ask about what they saw.',
    liveOnly:
      'Your cameras are connected for live view only right now. To ask about what happened, Sightline needs a recorder or camera that keeps events, and a connection to it.',
    loadingIndex: 'Loading your recordings…',
    searching: 'Looking through your recordings…',
    failed: (systems: string) => `Couldn’t load events from ${systems}, so answers leave them out.`,
    usedModel: 'Understood with Apple Intelligence, on this iPhone.',
    usedLocal: 'Understood on this iPhone.',
    countNote: ' Each recording counts once, so one visit can count more than once.',
    recordings: (n: number) => p(n, { one: `${n} recording`, other: `${n} recordings` }),
    showingLatest: (n: number) => ` (showing the latest ${n})`,
    tryAsking: 'Try asking',
    /** Example questions shown as chips (tapping one asks the English question behind it). */
    examples: {
      package: 'Did a package come today?',
      backyard: 'Was anyone in the backyard last night?',
      kids: 'When did the kids get home?',
      cars: 'How many cars came by this week?',
      delivery: 'Show me the delivery driver',
      door: 'Who came to the door today?',
    },
    /** VoiceOver label for one matching recording. */
    rowLabel: (subject: string, camera: string, when: string) => `${subject} on ${camera}, ${when}. Play.`,
  },
  // components/review/ask-bar.tsx
  bar: {
    label: 'Ask your cameras a question',
    hint: 'Ask your cameras…',
    speak: 'Ask by speaking',
  },
  // ask/ask.ts: why answers are simpler right now
  simple: {
    disabled: 'Turn on Apple Intelligence in Settings for smarter answers. Until then Sightline understands common questions.',
    notReady: 'Apple Intelligence is still getting ready on this iPhone. Until then Sightline understands common questions.',
    language: 'Apple Intelligence doesn’t support your iPhone’s language yet, so Sightline understands common English questions.',
    other: 'Sightline understands common questions on this iPhone. With Apple Intelligence (iOS 26 on a newer iPhone) it understands more.',
  },
  // ask/engine.ts: the answers. Leading spaces are part of the text (they follow other words).
  answer: {
    or: 'or',
    /** What was asked about, one of it: "Did you see a package?" */
    one: {
      person: 'someone',
      vehicle: 'a car',
      package: 'a package',
      delivery: 'a delivery',
      animal: 'an animal',
      bicycle: 'a bike',
      doorbell: 'a doorbell ring',
    } as Record<string, string>,
    /** …several of it: "I saw cars 3 times". */
    many: {
      person: 'people',
      vehicle: 'cars',
      package: 'packages',
      delivery: 'deliveries',
      animal: 'animals',
      bicycle: 'bikes',
      doorbell: 'doorbell rings',
    } as Record<string, string>,
    /** …in a "didn't see" sentence: "I didn't see a package". */
    none: {
      person: 'someone',
      vehicle: 'a car',
      package: 'a package',
      delivery: 'a delivery',
      animal: 'an animal',
      bicycle: 'a bike',
      doorbell: 'a doorbell ring',
    } as Record<string, string>,
    /** People by name in a "didn't see" sentence. */
    noneNames: (names: string) => names,
    /** Nothing in particular, in a "didn't see" sentence. */
    nothing: 'anything',
    /** People by name in "I saw … 3 times". */
    manyNames: (names: string) => names,
    /** Nothing in particular, in "I saw … 3 times". */
    events: 'events',
    /** What one recording shows, by the label the recorder gave it. */
    labels: {
      person: 'someone',
      face: 'someone',
      car: 'a car',
      truck: 'a truck',
      vehicle: 'a vehicle',
      motorcycle: 'a motorcycle',
      bus: 'a bus',
      package: 'a package',
      dog: 'a dog',
      cat: 'a cat',
      bird: 'a bird',
      bicycle: 'a bike',
      doorbell: 'a doorbell ring',
    } as Record<string, string>,
    /** Any other label ("Deer"). */
    something: (label: string) => `a ${label.toLowerCase()}`,
    motion: 'motion',
    someoneUnknown: "someone I don't recognize",
    // Where
    inZones: (zones: string) => ` in ${zones}`,
    inZonesOn: (zones: string, cameras: string) => ` in ${zones} on ${cameras}`,
    onCameras: (cameras: string) => ` on ${cameras}`,
    // When
    times: {
      'in the last few minutes': 'in the last few minutes',
      'in the last hour': 'in the last hour',
      today: 'today',
      'this morning': 'this morning',
      'this afternoon': 'this afternoon',
      'this evening': 'this evening',
      'last night': 'last night',
      yesterday: 'yesterday',
      'in the last 24 hours': 'in the last 24 hours',
      'this weekend': 'this weekend',
      'this week': 'this week',
      'last week': 'last week',
      'in the past week': 'in the past week',
    } as Record<string, string>,
    onDay: (day: string) => `on ${day}`,
    lastMinutes: (n: number) => p(n, { one: 'in the last minute', other: `in the last ${n} minutes` }),
    lastHours: (n: number) => p(n, { one: 'in the last hour', other: `in the last ${n} hours` }),
    lastDays: (n: number) => p(n, { one: 'in the last day', other: `in the last ${n} days` }),
    parts: {
      morning: ' in the morning',
      afternoon: ' in the afternoon',
      evening: ' in the evening',
      night: ' at night',
    } as Record<string, string>,
    at: (time: string) => `at ${time}`,
    yesterdayAt: (time: string) => `yesterday at ${time}`,
    onDayAt: (day: string, time: string) => `on ${day} at ${time}`,
    /** "someone on Front Door at 3:30 PM" */
    describe: (subject: string, camera: string, time: string) => `${subject} on ${camera} ${time}`,
    // Did … ?
    yesNoNone: (what: string, where: string, when: string) => `No, I didn't see ${what}${where} ${when}.`,
    yesNoNothing: (where: string, when: string) => `No, nothing was recorded${where} ${when}.`,
    yesOne: (subject: string, camera: string, time: string) => `Yes. ${cap(subject)} was seen on ${camera} ${time}.`,
    yesMany: (n: number, when: string, latest: string) => `Yes, ${n} times ${when}. The latest was ${latest}.`,
    // How many … ?
    countNone: (what: string, where: string, when: string) => `None. I didn't see ${what}${where} ${when}.`,
    countSeen: (what: string, where: string, n: number, when: string, latest: string) =>
      `I saw ${what}${where} ${p(n, { one: 'once', other: `${n} times` })} ${when}. The latest was ${latest}.`,
    // When … ?
    whenNone: (what: string, where: string, when: string) => `I didn't see ${what}${where} ${when}.`,
    whenSeen: (subject: string, time: string, camera: string) => `${cap(subject)} was seen ${time} on ${camera}.`,
    whenBefore: (times: string) => ` Before that: ${times}.`,
    // Who … ?
    whoNone: (where: string, when: string) => `Nobody was seen${where} ${when}.`,
    whoOne: (who: string, where: string, when: string) => `${cap(who)} was seen${where} ${when}.`,
    whoMany: (who: string, where: string, when: string) => `${cap(who)} were seen${where} ${when}.`,
    whoLatest: (latest: string) => ` The latest was ${latest}.`,
    // Show me …
    listNone: (what: string, where: string, when: string) => `I didn't find ${what}${where} ${when}.`,
    listFound: (n: number, when: string, latest: string) =>
      `${p(n, { one: 'One match', other: `${n} matches` })} ${when}. The latest is ${latest}.`,
  },
};

export default ask;
