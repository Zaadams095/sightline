import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Button, Field, IconButton, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp, type CameraGroup } from '@/state/store';
import { useFeatureSupport } from '@/systems/caps';
import { getAdapter, useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Camera groups (Front Yard, Indoors…) shown as chips at the top of the Live tab. */
export default function GroupsSettings() {
  const p = usePalette();
  const t = useT();
  const gt = t.settings.groups;
  const groups = useApp((s) => s.cameraGroups);
  const saveGroup = useApp((s) => s.saveGroup);
  const deleteGroup = useApp((s) => s.deleteGroup);
  const moveGroup = useApp((s) => s.moveGroup);
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const { entries } = useAllCameras({ includeHidden: true });
  const support = useFeatureSupport();
  const [editing, setEditing] = useState<CameraGroup | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const importFromRecorders = async () => {
    setMsg(null);
    let added = 0;
    for (const s of systems) {
      const adapter = getAdapter(s, links[s.id]);
      const remote = await adapter?.groups?.().catch(() => null);
      for (const g of remote ?? []) {
        const existing = groups.find((x) => x.source === s.id && x.name === g.name);
        saveGroup({
          id: existing?.id ?? `${s.id}-${g.name}`,
          name: g.name,
          cameraKeys: g.cameraIds.map((id) => `${s.id}:${id}`),
          source: s.id,
        });
        added++;
      }
    }
    setMsg(added ? gt.imported(added) : gt.noneFound);
  };

  if (editing) {
    const toggle = (key: string) =>
      setEditing({
        ...editing,
        cameraKeys: editing.cameraKeys.includes(key) ? editing.cameraKeys.filter((k) => k !== key) : [...editing.cameraKeys, key],
      });
    return (
      <Screen>
        <Field label={gt.groupName} value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} autoCapitalize="words" placeholder={gt.placeholder} />
        <Section title={gt.camerasN(editing.cameraKeys.length)}>
          {entries.map((e, i) => (
            <Row
              key={e.camera.key}
              label={e.camera.name}
              last={i === entries.length - 1}
              right={<Switch value={editing.cameraKeys.includes(e.camera.key)} onValueChange={() => toggle(e.camera.key)} trackColor={{ true: p.accent }} />}
            />
          ))}
        </Section>
        <Button
          title={gt.saveGroup}
          disabled={!editing.name.trim() || !editing.cameraKeys.length}
          onPress={() => {
            saveGroup({ ...editing, name: editing.name.trim() });
            setEditing(null);
          }}
        />
        <Button title={t.common.cancel} kind="ghost" onPress={() => setEditing(null)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <T muted>{gt.intro}</T>

      {groups.length > 0 && (
        <Section>
          {groups.map((g, i) => (
            <View key={g.id} style={[styles.row, { borderBottomColor: p.border, borderBottomWidth: i === groups.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
              <View style={styles.arrows}>
                <IconButton icon="chevron.up" label={t.settings.moveUp(g.name)} onPress={() => moveGroup(g.id, -1)} disabled={i === 0} />
                <IconButton icon="chevron.down" label={t.settings.moveDown(g.name)} onPress={() => moveGroup(g.id, 1)} disabled={i === groups.length - 1} />
              </View>
              <Pressable style={{ flex: 1, minHeight: 44, justifyContent: 'center' }} onPress={() => setEditing(g)} accessibilityRole="button" accessibilityHint={gt.editHint}>
                <T>{g.name}</T>
                <T v="caption" muted>
                  {t.common.cameras(g.cameraKeys.length)}
                  {g.source ? ` · ${gt.fromRecorder}` : ''}
                </T>
              </Pressable>
              <Pressable
                onPress={() => deleteGroup(g.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={gt.deleteName(g.name)}
                style={{ minHeight: 44, justifyContent: 'center' }}>
                <T color={p.danger}>{t.common.delete}</T>
              </Pressable>
            </View>
          ))}
        </Section>
      )}

      <Button title={gt.newGroup} onPress={() => setEditing({ id: Date.now().toString(36), name: '', cameraKeys: [] })} />
      {support.groups && <Button title={gt.importGroups} kind="secondary" onPress={() => void importFromRecorders()} />}
      {msg && <T muted>{msg}</T>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, minHeight: 56 },
  arrows: { flexDirection: 'row', marginLeft: -space.sm },
});
