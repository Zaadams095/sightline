import { router } from 'expo-router';

import type { Story } from '@/stories/group';
import type { ReviewItem } from '@/systems/types';

/** Stories opened from a list this session, so the story view shows exactly what was tapped. */
const recent = new Map<string, Story<ReviewItem>>();

export function recallStory(id: string): Story<ReviewItem> | null {
  return recent.get(id) ?? null;
}

/** Opens the story view. Params also carry the event ids so it can be rebuilt after a restart. */
export function openStory(story: Story<ReviewItem>) {
  recent.set(story.id, story);
  if (recent.size > 30) recent.delete(recent.keys().next().value!);
  const items = story.steps.flatMap((s) => s.items);
  const systems = [...new Set(items.map((i) => i.systemId))];
  router.push({
    pathname: '/story',
    params: {
      storyId: story.id,
      ids: items.map((i) => i.id).join(','),
      // Single-system stories pin the system; mixed ones match ids across systems.
      systemId: systems.length === 1 ? systems[0] : '',
      start: String(Math.floor(story.start)),
      end: String(Math.ceil(story.end)),
    },
  });
}
