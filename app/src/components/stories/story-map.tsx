import { View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { CameraMapView } from '@/components/map/camera-map-view';
import type { CameraMap } from '@/state/store';
import type { Story } from '@/stories/group';
import { usePalette } from '@/theme/use-palette';

interface Props {
  map: CameraMap;
  story: Story;
  names: Map<string, string>;
  width: number;
  /** 0 … steps-1: where along the story the moving dot is (fractions between steps). */
  progress: number;
}

/** Placed steps of a story, in order (cameras not on the map are skipped). */
export function placedSteps(map: CameraMap, story: Story): { i: number; x: number; y: number }[] {
  return story.steps
    .map((s, i) => ({ i, p: map.placements[s.cameraKey] }))
    .filter((s) => !!s.p)
    .map((s) => ({ i: s.i, x: s.p!.x, y: s.p!.y }));
}

/** Where the dot is at `progress`, between the placed steps around it. */
export function dotAt(placed: { i: number; x: number; y: number }[], progress: number): { x: number; y: number } | null {
  if (!placed.length) return null;
  let a = placed[0];
  let b = placed[placed.length - 1];
  for (const p of placed) {
    if (p.i <= progress) a = p;
    if (p.i > progress) {
      b = p;
      break;
    }
  }
  if (a === b || b.i <= a.i || progress <= a.i) return { x: a.x, y: a.y };
  const f = Math.min(1, (progress - a.i) / (b.i - a.i));
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** The property map with the story's path drawn over it and a dot walking along it. */
export function StoryMap({ map, story, names, width, progress }: Props) {
  const p = usePalette();
  const placed = placedSteps(map, story);
  if (placed.length < 2) return null;
  const height = width / map.aspect;
  const dot = dotAt(placed, progress);
  const current = story.steps[Math.min(story.steps.length - 1, Math.max(0, Math.floor(progress)))]?.cameraKey ?? null;
  return (
    <View style={{ width, height }}>
      <CameraMapView map={map} width={width} names={names} active={new Set(story.cameras)} selected={current} />
      <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
        <Polyline
          points={placed.map((s) => `${s.x * width},${s.y * height}`).join(' ')}
          fill="none"
          stroke={p.accent}
          strokeWidth={3}
          strokeDasharray="7,5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {dot && <Circle cx={dot.x * width} cy={dot.y * height} r={8} fill={p.accent} stroke="#fff" strokeWidth={2} />}
      </Svg>
    </View>
  );
}
