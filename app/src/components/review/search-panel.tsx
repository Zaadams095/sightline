import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Button, Chip, Field, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { SearchHit } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatRelative, labelFor } from '@/util/format';

const EXAMPLES = ['person carrying a package', 'white pickup truck', 'dog in the yard', 'someone at the door at night'];

/**
 * Smart search over Frigate's semantic index: "description" matches generated/AI descriptions,
 * "thumbnail" matches what the object looked like.
 */
export function SearchPanel() {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const radius = useApp((s) => s.appearance.radius);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'thumbnail' | 'description'>('thumbnail');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (q = query) => {
    if (!q.trim()) return;
    setQuery(q);
    setBusy(true);
    setError(null);
    try {
      const searchable = systems.map((s) => getAdapter(s, links[s.id])).filter((a) => a?.search);
      if (!searchable.length) throw new Error('None of your systems support smart search.');
      const results = await Promise.allSettled(searchable.map((a) => a!.search!({ query: q.trim(), type, limit: 60 })));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (!ok.length && firstErr) throw firstErr.reason;
      setHits(ok);
    } catch (e) {
      setHits(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cols = width > 700 ? 4 : 2;
  const tileW = (width - space.lg * 2 - space.sm * (cols - 1)) / cols;

  return (
    <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
      <Field
        label="Describe what you're looking for"
        value={query}
        onChangeText={setQuery}
        placeholder="person in a red jacket"
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={() => void run()}
      />
      <View style={styles.row}>
        <Chip label="Looks like" selected={type === 'thumbnail'} onPress={() => setType('thumbnail')} />
        <Chip label="Description" selected={type === 'description'} onPress={() => setType('description')} />
      </View>
      <Button title="Search" onPress={() => void run()} loading={busy} disabled={!query.trim()} />

      {error && <T color={p.danger}>{error}</T>}

      {!hits && !error && !busy && (
        <View style={{ gap: space.sm }}>
          <T v="caption" muted>
            Try
          </T>
          <View style={styles.row}>
            {EXAMPLES.map((ex) => (
              <Chip key={ex} label={ex} selected={false} onPress={() => void run(ex)} />
            ))}
          </View>
        </View>
      )}

      {busy && <ActivityIndicator />}

      {hits && !busy && (
        <>
          <T v="caption" muted>
            {hits.length ? `${hits.length} matches, best first` : 'No matches'}
          </T>
          <View style={[styles.row, { gap: space.sm }]}>
            {hits.map((h) => (
              <Pressable
                key={`${h.systemId}:${h.eventId}`}
                style={{ width: tileW, gap: 4 }}
                onPress={() =>
                  router.push({
                    pathname: '/playback',
                    params: { systemId: h.systemId, cameraId: h.cameraId, start: String(Math.floor(h.startTime - 3)) },
                  })
                }>
                <View style={[styles.thumb, { height: tileW * 0.75, borderRadius: Math.min(radius, 12), backgroundColor: p.surface }]}>
                  <Image source={{ uri: h.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                </View>
                <T v="label" numberOfLines={1}>
                  {h.subLabel ?? labelFor([h.label])}
                </T>
                <T v="caption" muted numberOfLines={1}>
                  {h.cameraId.replace(/_/g, ' ')} · {formatRelative(h.startTime)}
                </T>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  thumb: { overflow: 'hidden' },
});
