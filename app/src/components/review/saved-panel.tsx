import { router } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp, type SavedClip } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock, formatDay } from '@/util/format';
import { deleteOfflineClip, downloadClipForOffline, shareLocalFile } from '@/util/share';

/** Bookmarked moments. Downloaded ones play offline, even with no connection to home. */
export function SavedPanel() {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
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
    const L = t.home.saved;
    const canDownload = !!adapterFor(c)?.clip;
    const opts = [
      c.localUri ? t.common.share : canDownload ? L.download : null,
      c.localUri ? L.removeDownload : null,
      L.deleteBookmark,
      t.common.cancel,
    ].filter(Boolean) as string[];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: c.title, options: opts, destructiveButtonIndex: opts.indexOf(L.deleteBookmark), cancelButtonIndex: opts.length - 1 },
      async (i) => {
        const choice = opts[i];
        try {
          if (choice === t.common.share && c.localUri) await shareLocalFile(c.localUri, c.cameraName);
          if (choice === L.download) {
            const adapter = adapterFor(c);
            if (!adapter) throw new Error(L.cantReach);
            setBusyId(c.id);
            const uri = await downloadClipForOffline(adapter, c);
            saveClip({ ...c, localUri: uri });
          }
          if (choice === L.removeDownload && c.localUri) {
            deleteOfflineClip(c.localUri);
            saveClip({ ...c, localUri: undefined });
          }
          if (choice === L.deleteBookmark) {
            if (c.localUri) deleteOfflineClip(c.localUri);
            // Let the recorder's normal retention apply again.
            const adapter = adapterFor(c);
            await Promise.allSettled(c.retainedEvents.map((id) => adapter?.retain?.(id, false)));
            removeClip(c.id);
          }
        } catch (e) {
          Alert.alert(L.somethingWrong, e instanceof Error ? e.message : String(e));
        } finally {
          setBusyId(null);
        }
      },
    );
  };

  if (!clips.length) {
    return (
      <View style={styles.empty}>
        <T v="heading" style={{ textAlign: 'center' }}>
          {t.home.saved.emptyTitle}
        </T>
        <T muted style={{ textAlign: 'center' }}>
          {t.home.saved.emptyBody}
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
          style={({ pressed }) => [styles.item, large && styles.itemWrap, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
          {/* At big text sizes the title gets the whole line; status and the menu move under it. */}
          <View style={large ? { flexBasis: '100%', gap: 2 } : { flex: 1, gap: 2 }}>
            <T v="label" numberOfLines={large ? undefined : 1}>
              {c.title}
            </T>
            <T v="caption" muted>
              {c.cameraName} · {formatDay(c.start)} {formatClock(c.start)} · {t.home.saved.duration(Math.round(c.end - c.start))}
            </T>
          </View>
          <T v="caption" color={c.localUri ? p.success : p.textMuted} style={large ? { flex: 1 } : undefined}>
            {busyId === c.id ? t.home.saved.downloading : c.localUri ? t.home.saved.offline : ''}
          </T>
          <Pressable onPress={() => actions(c)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.home.saved.more}>
            <T muted>•••</T>
          </Pressable>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  itemWrap: { flexWrap: 'wrap' },
  empty: { alignItems: 'center', gap: space.sm, padding: space.xxl },
});
