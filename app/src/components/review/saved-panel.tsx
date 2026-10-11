import { router } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp, type SavedClip } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock, formatDay } from '@/util/format';
import { deleteOfflineClip, downloadClipForOffline, shareLocalFile } from '@/util/share';

/** Bookmarked moments. Downloaded ones play offline, even with no connection to home. */
export function SavedPanel() {
  const p = usePalette();
  const clips = useApp((s) => s.savedClips);
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const saveClip = useApp((s) => s.saveClip);
  const removeClip = useApp((s) => s.removeClip);
  const [busyId, setBusyId] = useState<string | null>(null);

  const adapterFor = (c: SavedClip) => {
    const s = systems.find((x) => x.id === c.systemId);
    return s ? getAdapter(s, links[s.id]) : null;
  };

  const open = (c: SavedClip) => {
    if (c.localUri) router.push({ pathname: '/clip', params: { id: c.id } });
    else router.push({ pathname: '/playback', params: { systemId: c.systemId, cameraId: c.cameraId, start: String(Math.floor(c.start)) } });
  };

  const actions = (c: SavedClip) => {
    const canDownload = !!adapterFor(c)?.clip;
    const opts = [
      c.localUri ? 'Share' : canDownload ? 'Download to this phone' : null,
      c.localUri ? 'Remove download' : null,
      'Delete bookmark',
      'Cancel',
    ].filter(Boolean) as string[];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: c.title, options: opts, destructiveButtonIndex: opts.indexOf('Delete bookmark'), cancelButtonIndex: opts.length - 1 },
      async (i) => {
        const choice = opts[i];
        try {
          if (choice === 'Share' && c.localUri) await shareLocalFile(c.localUri, c.cameraName);
          if (choice === 'Download to this phone') {
            const adapter = adapterFor(c);
            if (!adapter) throw new Error('Can’t reach the recorder right now.');
            setBusyId(c.id);
            const uri = await downloadClipForOffline(adapter, c);
            saveClip({ ...c, localUri: uri });
          }
          if (choice === 'Remove download' && c.localUri) {
            deleteOfflineClip(c.localUri);
            saveClip({ ...c, localUri: undefined });
          }
          if (choice === 'Delete bookmark') {
            if (c.localUri) deleteOfflineClip(c.localUri);
            // Let the recorder's normal retention apply again.
            const adapter = adapterFor(c);
            await Promise.allSettled(c.retainedEvents.map((id) => adapter?.retain?.(id, false)));
            removeClip(c.id);
          }
        } catch (e) {
          Alert.alert('Something went wrong', e instanceof Error ? e.message : String(e));
        } finally {
          setBusyId(null);
        }
      },
    );
  };

  if (!clips.length) {
    return (
      <View style={styles.empty}>
        <T v="heading">No saved clips yet</T>
        <T muted style={{ textAlign: 'center' }}>
          Tap the star while watching a recording to bookmark it. Download a bookmark to keep a copy on your phone, even after your recorder
          clears old video.
        </T>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
      {clips.map((c) => (
        <Pressable
          key={c.id}
          onPress={() => open(c)}
          onLongPress={() => actions(c)}
          style={({ pressed }) => [styles.item, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="label" numberOfLines={1}>
              {c.title}
            </T>
            <T v="caption" muted>
              {c.cameraName} · {formatDay(c.start)} {formatClock(c.start)} · {Math.round(c.end - c.start)}s
            </T>
          </View>
          <T v="caption" color={c.localUri ? p.success : p.textMuted}>
            {busyId === c.id ? 'Downloading…' : c.localUri ? 'Offline' : ''}
          </T>
          <Pressable onPress={() => actions(c)} hitSlop={10}>
            <T muted>•••</T>
          </Pressable>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  empty: { alignItems: 'center', gap: space.sm, padding: space.xxl },
});
