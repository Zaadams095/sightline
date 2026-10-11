import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Polygon, Polyline, Text as SvgText } from 'react-native-svg';

import {
  clampPt,
  describeZone,
  nearestVertex,
  nextZoneId,
  pointInPolygon,
  ZONE_OBJECTS,
  ZONE_PRESETS,
  zoneSupportFor,
  type AlertZone,
  type Pt,
  type ZoneObject,
} from '@/alerts/zones';
import { LiveView, useLive } from '@/components/live/live-view';
import { Button, Chip, Section, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import { font, space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const NAMES = ['Driveway', 'Porch', 'Yard', 'Walkway', 'Street', 'Sidewalk'];
/** Finger-sized: handles are drawn at 12pt but grabbed from 30pt away. */
const HANDLE_R = 12;
const GRAB_PX = 30;

/**
 * Activity zones on the live picture: "only alert me about the driveway" (include) or "ignore
 * the street" (exclude). Draw by tapping corners, drag the round handles to adjust, or start
 * from a quick shape. How the zones are applied depends on the camera (alerts/zones.ts).
 */
export default function ZoneEditor() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [systemId, cameraId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const adapter = useAdapter(systemId);
  const saved = useApp((s) => s.alertZones[key]);
  const setZones = useApp((s) => s.setZones);

  const cameras = useQuery({
    queryKey: ['cameras-of', systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const camera = cameras.data?.find((c) => c.id === cameraId);
  const support = adapter && camera ? zoneSupportFor(adapter, camera) : null;
  const live = useLive(adapter, cameraId, 'sub', support !== false && support !== null);

  const [zones, setZonesDraft] = useState<AlertZone[]>(() => saved ?? []);
  const [history, setHistory] = useState<AlertZone[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const dirty = JSON.stringify(zones) !== JSON.stringify(saved ?? []);

  // Layout: picture on top (phone) or beside the list (iPad / landscape).
  const wide = width >= 700;
  const aspect = camera?.aspect ?? 16 / 9;
  const availW = wide ? width - 400 - space.lg * 3 : width - space.lg * 2;
  const maxH = wide ? height - insets.top - 140 : height * 0.42;
  const picW = Math.max(200, Math.min(availW, maxH * aspect));
  const picH = picW / aspect;

  const current = zones.find((z) => z.id === selected) ?? null;
  const commit = (next: AlertZone[]) => {
    setHistory((h) => [...h.slice(-49), zones]);
    setZonesDraft(next);
    setMessage(null);
  };
  const update = (id: string, patch: Partial<AlertZone>, record = true) => {
    const next = zones.map((z) => (z.id === id ? { ...z, ...patch } : z));
    if (record) commit(next);
    else setZonesDraft(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setZonesDraft(prev);
    if (selected && !prev.some((z) => z.id === selected)) {
      setSelected(null);
      setDrawing(false);
    }
  };
  const finishDrawing = () => {
    setDrawing(false);
    if (current && current.points.length < 3) {
      commit(zones.filter((z) => z.id !== current.id));
      setSelected(null);
    }
  };
  const newZone = (points: Pt[] = [], name?: string): AlertZone => {
    const used = new Set(zones.map((z) => z.name));
    const fallback = NAMES.find((n) => !used.has(n)) ?? `Zone ${zones.length + 1}`;
    return { id: nextZoneId(zones), name: name && !used.has(name) ? name : fallback, mode: 'include', points, objects: [] };
  };
  const startDrawing = () => {
    const z = newZone();
    commit([...zones.filter((x) => x.points.length >= 3), z]);
    setSelected(z.id);
    setDrawing(true);
  };
  const applyPreset = (points: Pt[], name: string) => {
    if (current) update(current.id, { points });
    else {
      const z = newZone(points, name);
      commit([...zones, z]);
      setSelected(z.id);
    }
    setDrawing(false);
  };

  // Gestures: drag a handle of the selected zone; tap to add a corner, close the shape, or select.
  const toNorm = (x: number, y: number) => clampPt({ x: x / picW, y: y / picH });
  const radius = GRAB_PX / picH;
  const [dragIndex, setDragIndex] = useState(-1);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .manualActivation(true)
    .onTouchesDown((e, mgr) => {
      const t = e.allTouches[0];
      const pts = current?.points ?? [];
      const i = t ? nearestVertex(pts, toNorm(t.x, t.y), radius, picW / picH) : -1;
      // Tapping the first corner while drawing closes the shape (handled by the tap).
      if (i < 0 || (drawing && i === 0 && pts.length >= 3)) {
        mgr.fail();
        return;
      }
      setDragIndex(i);
      setHistory((h) => [...h.slice(-49), zones]);
      void Haptics.selectionAsync();
      mgr.activate();
    })
    .onUpdate((e) => {
      if (!current || dragIndex < 0) return;
      const points = current.points.map((q, i) => (i === dragIndex ? toNorm(e.x, e.y) : q));
      update(current.id, { points }, false);
    })
    .onFinalize(() => {
      setDragIndex(-1);
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(500)
    .onEnd((e) => {
      const pt = toNorm(e.x, e.y);
      if (drawing && current) {
        if (current.points.length >= 3 && nearestVertex([current.points[0]], pt, radius, picW / picH) === 0) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setDrawing(false);
          return;
        }
        update(current.id, { points: [...current.points, pt] });
        void Haptics.selectionAsync();
        return;
      }
      const hit = [...zones].reverse().find((z) => pointInPolygon(pt, z.points));
      setSelected(hit?.id ?? null);
    });
  const gesture = Gesture.Exclusive(pan, tap);

  const save = async () => {
    if (!adapter) return;
    const clean = zones.filter((z) => z.points.length >= 3).map((z) => ({ ...z, name: z.name.trim() || 'Zone' }));
    setSaving(true);
    setMessage(null);
    try {
      let text = clean.length ? 'Saved. Alerts follow these zones from now on.' : 'Saved. This camera alerts about its whole picture again.';
      if (support === 'device' && adapter.applyZones) text = await adapter.applyZones(cameraId, clean);
      setZones(key, clean);
      setZonesDraft(clean);
      setDrawing(false);
      setMessage({ text });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Couldn’t save the zones.', error: true });
    } finally {
      setSaving(false);
    }
  };

  // Shown full screen (it opens from the full-screen camera view too), so it brings its own Close.
  const header = (
    <Stack.Screen
      options={{
        title: 'Alert zones',
        headerLeft: () => (
          <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={12} style={{ minHeight: 44, justifyContent: 'center' }}>
            <T v="label" color={p.accent}>
              {dirty ? 'Cancel' : 'Close'}
            </T>
          </Pressable>
        ),
      }}
    />
  );

  const colorOf = (z: AlertZone) => (z.mode === 'include' ? p.success : p.danger);
  const svgPts = (pts: Pt[]) => pts.map((q) => `${q.x * picW},${q.y * picH}`).join(' ');

  const picture = (
    <View style={{ width: picW, height: picH, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000', alignSelf: 'center' }}>
      {adapter && (
        <Image source={{ uri: adapter.snapshot(cameraId, { height: 720 }).uri }} style={StyleSheet.absoluteFill} contentFit="fill" />
      )}
      {live.data && <LiveView live={live.data} fit="cover" />}
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} accessibilityLabel="Camera picture. Tap to add corners of a zone." accessibilityHint="Drag the round handles to adjust the selected zone.">
          <Svg width={picW} height={picH}>
            {zones.map((z) => {
              const sel = z.id === selected;
              const c = colorOf(z);
              if (z.points.length < 3)
                return z.points.length > 1 ? <Polyline key={z.id} points={svgPts(z.points)} fill="none" stroke="#fff" strokeWidth={3} strokeDasharray="8 6" /> : null;
              const cx = (z.points.reduce((s, q) => s + q.x, 0) / z.points.length) * picW;
              const cy = (z.points.reduce((s, q) => s + q.y, 0) / z.points.length) * picH;
              return [
                <Polygon
                  key={z.id}
                  points={svgPts(z.points)}
                  fill={c}
                  fillOpacity={sel ? 0.35 : 0.22}
                  stroke={sel ? '#fff' : c}
                  strokeWidth={sel ? 3 : 2}
                  strokeDasharray={drawing && sel ? '8 6' : undefined}
                />,
                <SvgText key={`${z.id}-label`} x={cx} y={cy} fill="#fff" fontSize={15} fontWeight="700" textAnchor="middle" stroke="rgba(0,0,0,0.6)" strokeWidth={0.6}>
                  {z.name}
                </SvgText>,
              ];
            })}
            {current?.points.map((q, i) => (
              <Circle
                key={i}
                cx={q.x * picW}
                cy={q.y * picH}
                r={drawing && i === 0 && current.points.length >= 3 ? HANDLE_R + 4 : HANDLE_R}
                fill="#fff"
                stroke={colorOf(current)}
                strokeWidth={3}
              />
            ))}
          </Svg>
        </View>
      </GestureDetector>
    </View>
  );

  if (support === false) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: p.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {header}
        <T v="heading">Zones can’t work for this camera</T>
        <T muted>
          This recorder can’t tell Sightline where things happened in the picture, and Sightline can’t change its detection area, so
          zones would only pretend to work. Alerts still come from the whole picture.
        </T>
        <T muted>
          To limit alerts to part of the view, set a motion or detection area in the camera’s or recorder’s own app. Zones work on
          cameras whose system reports where objects are (like Frigate, directly or through a Sightline Hub) and on cameras whose
          detection area Sightline can set (like Reolink).
        </T>
      </ScrollView>
    );
  }

  const editor = (
    <>
      <View style={styles.tools}>
        {drawing ? (
          <>
            <Button title="Done" onPress={finishDrawing} disabled={(current?.points.length ?? 0) < 3} style={styles.tool} />
            <Button title="Undo" kind="secondary" onPress={undo} disabled={!history.length} style={styles.tool} />
          </>
        ) : (
          <>
            <Button title="Draw a zone" onPress={startDrawing} style={styles.tool} />
            <Button title="Undo" kind="secondary" onPress={undo} disabled={!history.length} style={styles.tool} />
          </>
        )}
      </View>
      <T v="caption" muted>
        {drawing
          ? (current?.points.length ?? 0) < 3
            ? 'Tap the picture at each corner of the area. Three corners or more.'
            : 'Keep tapping to add corners, or tap the first corner (or Done) to finish. Drag a handle to move it.'
          : current
            ? 'Drag the round handles to adjust. Tap another zone to pick it.'
            : zones.length
              ? 'Tap a zone to change it, or draw another.'
              : 'Draw the area you care about, like the driveway, or pick a quick shape below.'}
      </T>

      <Section title={current ? `Quick shapes for “${current.name}”` : 'Quick shapes'}>
        <View style={styles.chips}>
          {ZONE_PRESETS.map((s) => (
            <Chip key={s.label} label={s.label} selected={false} onPress={() => applyPreset(s.points, s.name)} />
          ))}
        </View>
      </Section>

      {zones
        .filter((z) => z.points.length >= 3 || z.id === selected)
        .map((z) => (
          <ZoneCard
            key={z.id}
            zone={z}
            selected={z.id === selected}
            precise={support === 'precise'}
            objects={camera?.objects ?? []}
            onSelect={() => {
              if (drawing) finishDrawing();
              setSelected(z.id);
            }}
            onChange={(patch, record) => update(z.id, patch, record)}
            onRename={() => setHistory((h) => [...h.slice(-49), zones])}
            onClear={() => {
              update(z.id, { points: [] });
              setSelected(z.id);
              setDrawing(true);
            }}
            onDelete={() => {
              commit(zones.filter((x) => x.id !== z.id));
              if (selected === z.id) {
                setSelected(null);
                setDrawing(false);
              }
            }}
          />
        ))}

      <T v="caption" muted>
        {support === 'device'
          ? 'This camera does the detecting itself, so Sightline sets its own detection area: each zone covers all motion and smart detection, and it also decides when the camera records on motion.'
          : 'Sightline checks where each person, vehicle or animal walked or drove. Recording isn’t affected, and doorbell rings always come through.'}
      </T>
      <Button title={support === 'device' ? 'Save to camera' : 'Save'} onPress={save} loading={saving} disabled={!dirty && !message?.error} />
      {message && (
        <T v="caption" color={message.error ? p.danger : p.success}>
          {message.text}
        </T>
      )}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      {header}
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: space.lg, padding: space.lg }}>
          <View style={{ flex: 1, justifyContent: 'center' }}>{picture}</View>
          <ScrollView style={{ width: 400, flexGrow: 0 }} contentContainerStyle={{ gap: space.md, paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled">
            {editor}
          </ScrollView>
        </View>
      ) : (
        <>
          <View style={{ padding: space.lg, paddingBottom: space.sm }}>{picture}</View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: insets.bottom + space.xl }}
            keyboardShouldPersistTaps="handled">
            {editor}
          </ScrollView>
        </>
      )}
    </View>
  );
}

function ZoneCard({
  zone,
  selected,
  precise,
  objects,
  onSelect,
  onChange,
  onRename,
  onClear,
  onDelete,
}: {
  zone: AlertZone;
  selected: boolean;
  precise: boolean;
  objects: string[];
  onSelect: () => void;
  onChange: (patch: Partial<AlertZone>, record?: boolean) => void;
  onRename: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const p = usePalette();
  // Offer only kinds the camera can detect (packages only where it reports them).
  const kinds = useMemo(() => {
    const has = (k: ZoneObject) => k !== 'package' || objects.includes('package');
    return ZONE_OBJECTS.filter((o) => has(o.v));
  }, [objects]);
  const toggle = (o: ZoneObject) => onChange({ objects: zone.objects.includes(o) ? zone.objects.filter((x) => x !== o) : [...zone.objects, o] });
  const accent = zone.mode === 'include' ? p.success : p.danger;
  return (
    <View
      style={{
        backgroundColor: p.surface,
        borderRadius: 16,
        padding: space.md,
        gap: space.sm,
        borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
        borderColor: selected ? accent : p.border,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: accent }} />
        <TextInput
          value={zone.name}
          onFocus={() => {
            onRename();
            onSelect();
          }}
          onChangeText={(name) => onChange({ name }, false)}
          placeholder="Name, like Driveway"
          placeholderTextColor={p.textMuted}
          accessibilityLabel="Zone name"
          maxLength={40}
          style={[font.label, { flex: 1, fontSize: 17, color: p.text, minHeight: 44 }]}
        />
        {!selected && <Button title="Edit" kind="ghost" onPress={onSelect} style={{ height: 44, paddingHorizontal: space.md }} />}
      </View>
      {selected && (
        <View style={styles.chips0}>
          {NAMES.filter((n) => n !== zone.name).slice(0, 4).map((n) => (
            <Chip key={n} label={n} selected={false} onPress={() => onChange({ name: n })} />
          ))}
        </View>
      )}
      <T v="caption" muted>
        {describeZone(zone)}
      </T>
      <View style={styles.chips0}>
        <Chip label="Alert only here" selected={zone.mode === 'include'} onPress={() => onChange({ mode: 'include' })} />
        <Chip label="Ignore here" selected={zone.mode === 'exclude'} onPress={() => onChange({ mode: 'exclude' })} />
      </View>
      {precise && (
        <>
          <T v="label" muted>
            {zone.mode === 'include' ? 'Alert me about' : 'Ignore'}
          </T>
          <View style={styles.chips0}>
            <Chip label={zone.mode === 'include' ? 'Any motion' : 'Everything'} selected={zone.objects.length === 0} onPress={() => onChange({ objects: [] })} />
            {kinds.map((o) => (
              <Chip key={o.v} label={o.label} selected={zone.objects.includes(o.v)} onPress={() => toggle(o.v)} />
            ))}
          </View>
        </>
      )}
      {selected && (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button title="Redraw" kind="secondary" onPress={onClear} style={{ flex: 1 }} />
          <Button title="Delete zone" kind="secondary" onPress={onDelete} style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tools: { flexDirection: 'row', gap: space.sm },
  tool: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md },
  chips0: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
