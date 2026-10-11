import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Button, Field, IconButton, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp, type CameraGroup } from '@/state/store';
import { useFeatureSupport } from '@/systems/caps';
import { getAdapter, useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Camera groups (Front Yard, Indoors…) shown as chips at the top of the Live tab. */
export default function GroupsSettings() {
  const p = usePalette();
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
    setMsg(added ? `Imported ${added} group${added === 1 ? '' : 's'}.` : 'No camera groups found on your recorder.');
  };

  if (editing) {
    const toggle = (key: string) =>
      setEditing({
        ...editing,
        cameraKeys: editing.cameraKeys.includes(key) ? editing.cameraKeys.filter((k) => k !== key) : [...editing.cameraKeys, key],
      });
    return (
      <Screen>
        <Field label="Group name" value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} autoCapitalize="words" placeholder="Front Yard" />
        <Section title={`Cameras (${editing.cameraKeys.length})`}>
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
          title="Save group"
          disabled={!editing.name.trim() || !editing.cameraKeys.length}
          onPress={() => {
            saveGroup({ ...editing, name: editing.name.trim() });
            setEditing(null);
          }}
        />
        <Button title="Cancel" kind="ghost" onPress={() => setEditing(null)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <T muted>Groups appear as buttons at the top of the Live tab so you can jump straight to Front Yard, Back Yard or Indoors.</T>

      {groups.length > 0 && (
        <Section>
          {groups.map((g, i) => (
            <View key={g.id} style={[styles.row, { borderBottomColor: p.border, borderBottomWidth: i === groups.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
              <View style={styles.arrows}>
                <IconButton icon="chevron.up" label={`Move ${g.name} up`} onPress={() => moveGroup(g.id, -1)} disabled={i === 0} />
                <IconButton icon="chevron.down" label={`Move ${g.name} down`} onPress={() => moveGroup(g.id, 1)} disabled={i === groups.length - 1} />
              </View>
              <Pressable style={{ flex: 1, minHeight: 44, justifyContent: 'center' }} onPress={() => setEditing(g)} accessibilityRole="button" accessibilityHint="Edit this group">
                <T>{g.name}</T>
                <T v="caption" muted>
                  {g.cameraKeys.length} camera{g.cameraKeys.length === 1 ? '' : 's'}
                  {g.source ? ' · from your recorder' : ''}
                </T>
              </Pressable>
              <Pressable
                onPress={() => deleteGroup(g.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${g.name}`}
                style={{ minHeight: 44, justifyContent: 'center' }}>
                <T color={p.danger}>Delete</T>
              </Pressable>
            </View>
          ))}
        </Section>
      )}

      <Button title="New group" onPress={() => setEditing({ id: Date.now().toString(36), name: '', cameraKeys: [] })} />
      {support.groups && <Button title="Import groups from my recorder" kind="secondary" onPress={() => void importFromRecorders()} />}
      {msg && <T muted>{msg}</T>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, minHeight: 56 },
  arrows: { flexDirection: 'row', marginLeft: -space.sm },
});
