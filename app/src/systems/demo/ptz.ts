import { create } from 'zustand';

import type { PtzAction } from '@/systems/types';

/**
 * Pan/tilt/zoom of a sample camera's wide view. The "camera" is a wide video the live player
 * shows a window of (components/live/loop-live.tsx); moving it slides that window.
 * pan/tilt: -1 (left/top) … 1 (right/bottom); zoom: 1 (whole height) … MAX_ZOOM.
 */
export interface PtzView {
  pan: number;
  tilt: number;
  zoom: number;
}

export const DEFAULT_VIEW: PtzView = { pan: 0, tilt: 0, zoom: 1 };
const MAX_ZOOM = 3;
const TICK_MS = 33;
/** Units per second while a button is held. */
const SPEED = { pan: 0.55, tilt: 0.7, zoom: 0.9 };

interface Motion {
  dp: number;
  dt: number;
  dz: number;
  target?: PtzView;
}

export const useDemoPtz = create<{ views: Record<string, PtzView> }>(() => ({ views: {} }));

const moving = new Map<string, Motion>();
let timer: ReturnType<typeof setInterval> | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clampView(v: PtzView): PtzView {
  return { pan: clamp(v.pan, -1, 1), tilt: clamp(v.tilt, -1, 1), zoom: clamp(v.zoom, 1, MAX_ZOOM) };
}

/** One step of motion: held buttons move at a steady speed, presets glide to their target. */
export function stepView(v: PtzView, m: Motion, dtSec: number): { view: PtzView; done: boolean } {
  if (m.target) {
    const k = Math.min(1, dtSec * 5);
    const next = {
      pan: v.pan + (m.target.pan - v.pan) * k,
      tilt: v.tilt + (m.target.tilt - v.tilt) * k,
      zoom: v.zoom + (m.target.zoom - v.zoom) * k,
    };
    const close = Math.abs(next.pan - m.target.pan) + Math.abs(next.tilt - m.target.tilt) + Math.abs(next.zoom - m.target.zoom) < 0.004;
    return { view: close ? m.target : next, done: close };
  }
  return {
    view: clampView({ pan: v.pan + m.dp * SPEED.pan * dtSec, tilt: v.tilt + m.dt * SPEED.tilt * dtSec, zoom: v.zoom + m.dz * SPEED.zoom * dtSec }),
    done: false,
  };
}

function tick() {
  const views = { ...useDemoPtz.getState().views };
  for (const [key, m] of moving) {
    const { view, done } = stepView(views[key] ?? DEFAULT_VIEW, m, TICK_MS / 1000);
    views[key] = view;
    if (done) moving.delete(key);
  }
  useDemoPtz.setState({ views });
  if (!moving.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function run(key: string, m: Motion | null) {
  if (m) moving.set(key, m);
  else moving.delete(key);
  if (moving.size && !timer) timer = setInterval(tick, TICK_MS);
}

/** Start (or stop, with STOP) moving the view the way a PTZ button asks. */
export function demoPtzAction(key: string, action: PtzAction) {
  const m: Motion = { dp: 0, dt: 0, dz: 0 };
  if (action === 'MOVE_LEFT') m.dp = -1;
  else if (action === 'MOVE_RIGHT') m.dp = 1;
  else if (action === 'MOVE_UP') m.dt = -1;
  else if (action === 'MOVE_DOWN') m.dt = 1;
  else if (action === 'ZOOM_IN') m.dz = 1;
  else if (action === 'ZOOM_OUT') m.dz = -1;
  else return run(key, null);
  // Panning a view that shows everything would do nothing, so pans nudge the zoom in a bit.
  const v = useDemoPtz.getState().views[key] ?? DEFAULT_VIEW;
  if (m.dt && v.zoom < 1.25) m.dz = 0.5;
  run(key, m);
}

export function demoPtzPreset(key: string, view: PtzView) {
  run(key, { dp: 0, dt: 0, dz: 0, target: clampView(view) });
}
