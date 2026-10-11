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
import { Button, Chip, Section, T, useScaledFont } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import { useFontScale, useLargeText } from '@/theme/text-scale';
import { font, OVERLAY_MAX_SCALE, space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

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
  const t = useT();
  const zs = t.alertSettings.zones;
  const large = useLargeText();
  // Zone names drawn on the picture grow only a little with the text size, like other video overlays.
  const labelSize = 15 * Math.min(useFontScale(), OVERLAY_MAX_SCALE);
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
    const fallback = zs.names.find((n) => !used.has(n)) ?? zs.zoneN(zones.length + 1);
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
    const clean = zones.filter((z) => z.points.length >= 3).map((z) => ({ ...z, name: z.name.trim() || zs.zone }));
    setSaving(true);
    setMessage(null);
    try {
      let text = clean.length ? zs.savedZones : zs.savedWhole;
      if (support === 'device' && adapter.applyZones) text = await adapter.applyZones(cameraId, clean);
      setZones(key, clean);
      setZonesDraft(clean);
      setDrawing(false);
      setMessage({ text });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : zs.saveFailed, error: true });
    } finally {
      setSaving(false);
    }
  };

  // Shown full screen (it opens from the full-screen camera view too), so it brings its own Close.
  const header = (
    <Stack.Screen
      options={{
        title: zs.title,
        headerLeft: () => (
          <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={12} style={{ minHeight: 44, justifyContent: 'center' }}>
            <T v="label" color={p.accent}>
              {dirty ? t.common.cancel : t.common.close}
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
        <View style={StyleSheet.absoluteFill} accessibilityLabel={zs.pictureLabel} accessibilityHint={zs.pictureHint}>
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
                <SvgText key={`${z.id}-label`} x={cx} y={cy} fill="#fff" fontSize={labelSize} fontWeight="700" textAnchor="middle" stroke="rgba(0,0,0,0.6)" strokeWidth={0.6}>
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
        <T v="heading">{zs.cantTitle}</T>
        <T muted>{zs.cantBody1}</T>
        <T muted>{zs.cantBody2}</T>
      </ScrollView>
    );
  }

  const editor = (
    <>
      <View style={[styles.tools, large && { flexDirection: 'column' }]}>
        {drawing ? (
          <>
            <Button title={t.common.done} onPress={finishDrawing} disabled={(current?.points.length ?? 0) < 3} style={large ? undefined : styles.tool} />
            <Button title={zs.undo} kind="secondary" onPress={undo} disabled={!history.length} style={large ? undefined : styles.tool} />
          </>
        ) : (
          <>
            <Button title={zs.drawZone} onPress={startDrawing} style={large ? undefined : styles.tool} />
            <Button title={zs.undo} kind="secondary" onPress={undo} disabled={!history.length} style={large ? undefined : styles.tool} />
          </>
        )}
      </View>
      <T v="caption" muted>
        {drawing
          ? (current?.points.length ?? 0) < 3
            ? zs.hintFirst
            : zs.hintMore
          : current
            ? zs.hintSelected
            : zones.length
              ? zs.hintPick
              : zs.hintEmpty}
      </T>

      <Section title={current ? zs.quickShapesFor(current.name) : zs.quickShapes}>
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
        {support === 'device' ? zs.deviceNote : zs.preciseNote}
      </T>
      <Button title={support === 'device' ? zs.saveToCamera : t.common.save} onPress={save} loading={saving} disabled={!dirty && !message?.error} />
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
  const t = useT();
  const zs = t.alertSettings.zones;
  const large = useLargeText();
  const nameFont = useScaledFont('label');
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
          placeholder={zs.namePlaceholder}
          placeholderTextColor={p.textMuted}
          accessibilityLabel={zs.nameLabel}
          maxLength={40}
          maxFontSizeMultiplier={nameFont.maxFontSizeMultiplier}
          style={[font.label, { flex: 1, fontSize: (17 * (nameFont.style.fontSize ?? font.label.fontSize)) / font.label.fontSize, color: p.text, minHeight: 44 }]}
        />
        {!selected && <Button title={t.common.edit} kind="ghost" onPress={onSelect} style={{ minHeight: 44, paddingHorizontal: space.md }} />}
      </View>
      {selected && (
        <View style={styles.chips0}>
          {zs.names.filter((n) => n !== zone.name).slice(0, 4).map((n) => (
            <Chip key={n} label={n} selected={false} onPress={() => onChange({ name: n })} />
          ))}
        </View>
      )}
      <T v="caption" muted>
        {describeZone(zone)}
      </T>
      <View style={styles.chips0}>
        <Chip label={zs.onlyHere} selected={zone.mode === 'include'} onPress={() => onChange({ mode: 'include' })} />
        <Chip label={zs.ignoreHere} selected={zone.mode === 'exclude'} onPress={() => onChange({ mode: 'exclude' })} />
      </View>
      {precise && (
        <>
          <T v="label" muted>
            {zone.mode === 'include' ? zs.alertMeAbout : zs.ignore}
          </T>
          <View style={styles.chips0}>
            <Chip label={zone.mode === 'include' ? zs.anyMotion : zs.everything} selected={zone.objects.length === 0} onPress={() => onChange({ objects: [] })} />
            {kinds.map((o) => (
              <Chip key={o.v} label={o.label} selected={zone.objects.includes(o.v)} onPress={() => toggle(o.v)} />
            ))}
          </View>
        </>
      )}
      {selected && (
        <View style={{ flexDirection: large ? 'column' : 'row', gap: space.sm }}>
          <Button title={zs.redraw} kind="secondary" onPress={onClear} style={large ? undefined : { flex: 1 }} />
          <Button title={zs.deleteZone} kind="secondary" onPress={onDelete} style={large ? undefined : { flex: 1 }} />
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
