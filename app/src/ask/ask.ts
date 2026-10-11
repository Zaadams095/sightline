import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  acceptModelAnswer,
  buildIndex,
  composeAnswer,
  contextFor,
  parseQuestion,
  planContext,
  planToQuery,
  runQuery,
  WINDOW_DAYS,
  type AskContext,
  type AskQuery,
  type EventRecord,
} from '@/ask/engine';
import { cameraInfos, fetchEvents, writeAssistant } from '@/ask/sync';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter, useAllCameras } from '@/systems/registry';
import { Ask, type ModelAvailability } from '@modules/ask';

export interface AskResult {
  question: string;
  text: string;
  query: AskQuery;
  matches: EventRecord[];
  /** Apple's on-device model helped understand and phrase it. */
  usedModel: boolean;
}

export function modelAvailability(): ModelAvailability | 'missing' {
  if (!Ask) return 'missing';
  try {
    return Ask.availability();
  } catch {
    return 'unavailable';
  }
}

/** Why answers are simpler right now, in plain words (null when the model is in use). */
export function simpleModeReason(a: ModelAvailability | 'missing'): string | null {
  switch (a) {
    case 'available':
      return null;
    case 'disabled':
      return 'Turn on Apple Intelligence in Settings for smarter answers. Until then Sightline understands common questions.';
    case 'notReady':
      return 'Apple Intelligence is still getting ready on this iPhone. Until then Sightline understands common questions.';
    case 'language':
      return 'Apple Intelligence doesn’t support your iPhone’s language yet, so Sightline understands common English questions.';
    default:
      return 'Sightline understands common questions on this iPhone. With Apple Intelligence (iOS 26 on a newer iPhone) it understands more.';
  }
}

/**
 * Answers a question from the event index. With Apple Intelligence the on-device model turns
 * the question into a search and phrases the answer; otherwise (or if it fails) the rule-based
 * parser and the app's own sentence are used. Either way nothing leaves the phone.
 */
export async function askQuestion(question: string, index: EventRecord[], ctx: AskContext): Promise<AskResult> {
  const now = Date.now() / 1000;
  const parsed = parseQuestion(question, ctx, now);
  let query = parsed;
  let usedModel = false;
  if (Ask && modelAvailability() === 'available') {
    try {
      const plan = JSON.parse(await Ask.plan(question, JSON.stringify(planContext(ctx, now))));
      query = planToQuery(plan, ctx, now, parsed);
      usedModel = true;
    } catch {
      // Guardrails, a busy model, odd output: the parser's reading stands.
    }
  }
  const matches = runQuery(index, query);
  const draft = composeAnswer(query, matches, ctx, now);
  let text = draft.text;
  if (Ask && usedModel) {
    try {
      const phrased = (await Ask.answer(question, draft.facts.join('\n'))).trim();
      if (acceptModelAnswer(phrased, draft.facts, ctx)) text = phrased;
    } catch {}
  }
  return { question, text, query, matches, usedModel };
}

/**
 * The last week of events from every system that keeps them, as one brand-neutral index.
 * Also refreshes what Siri answers from.
 */
export function useEventIndex() {
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const { entries } = useAllCameras({ includeHidden: true });
  const cameras = useMemo(() => cameraInfos(entries), [entries]);

  const reachable = systems.filter((s) => links[s.id]?.mode === 'lan' || links[s.id]?.mode === 'tunnel');
  const adapters = reachable.map((s) => getAdapter(s, links[s.id])).filter((a) => !!a?.capabilities.review && !!a.listReview);

  const query = useQuery({
    queryKey: ['ask-index', reachable.map((s) => `${s.id}@${links[s.id]?.baseUrl}`).join('|'), cameras.length],
    enabled: adapters.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const after = Date.now() / 1000 - WINDOW_DAYS * 86400;
      const { items, failed } = await fetchEvents(adapters.map((a) => a!), after, 500);
      const knownNames = (
        await Promise.allSettled(adapters.filter((a) => a!.knownNames).map((a) => a!.knownNames!()))
      ).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const index = buildIndex(items, cameras);
      void writeAssistant(index, cameras).catch(() => {});
      return { index, ctx: contextFor(index, cameras, knownNames), failed };
    },
  });

  return { ...query, canReview: adapters.length > 0, hasSystems: systems.length > 0 };
}
