import { useEffect, useState } from 'react';
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { T, useScaledFont } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Cross-platform stand-ins for two iOS-only APIs:
 * - showActionSheet: ActionSheetIOS.showActionSheetWithOptions on iOS; on Android a bottom
 *   sheet in the app's colors (Android's Alert holds only three buttons).
 * - showPrompt: Alert.prompt on iOS (Android has no text prompt); on Android a small dialog.
 * Both Android versions draw in <DialogHost />, mounted once in the root layout.
 */

export interface ActionSheetOptions {
  title?: string;
  message?: string;
  options: string[];
  cancelButtonIndex?: number;
  destructiveButtonIndex?: number;
}

interface SheetRequest extends ActionSheetOptions {
  kind: 'sheet';
  onPick: (index: number) => void;
}

interface PromptRequest {
  kind: 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  onDone: (text: string | undefined) => void;
}

type Request = SheetRequest | PromptRequest;

let current: Request | null = null;
const listeners = new Set<(r: Request | null) => void>();

function show(r: Request | null) {
  current = r;
  for (const fn of listeners) fn(r);
}

/** Same arguments and callback as ActionSheetIOS.showActionSheetWithOptions. */
export function showActionSheet(options: ActionSheetOptions, onPick: (index: number) => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(options, onPick);
    return;
  }
  show({ kind: 'sheet', ...options, onPick });
}

/** A one-line text question. `onDone` gets the text, or undefined when cancelled (Android). */
export function showPrompt(title: string, message: string | undefined, onDone: (text: string | undefined) => void, defaultValue?: string) {
  if (Platform.OS === 'ios') {
    Alert.prompt(title, message, (text) => onDone(text), 'plain-text', defaultValue);
    return;
  }
  show({ kind: 'prompt', title, message, defaultValue, onDone });
}

/** Renders Android action sheets and prompts. Mount once, near the root. */
export function DialogHost() {
  const [req, setReq] = useState<Request | null>(current);
  useEffect(() => {
    listeners.add(setReq);
    return () => {
      listeners.delete(setReq);
    };
  }, []);
  if (Platform.OS === 'ios' || !req) return null;
  return req.kind === 'sheet' ? <Sheet req={req} /> : <Prompt req={req} />;
}

function Sheet({ req }: { req: SheetRequest }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const pick = (i: number | undefined) => {
    show(null);
    if (i != null && i >= 0) req.onPick(i);
  };
  const cancel = () => pick(req.cancelButtonIndex);
  const choices = req.options.map((label, i) => ({ label, i })).filter(({ i }) => i !== req.cancelButtonIndex);
  return (
    <Modal transparent visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={cancel}>
      <Pressable style={styles.backdrop} onPress={cancel} accessibilityRole="button" accessibilityLabel={req.cancelButtonIndex != null ? req.options[req.cancelButtonIndex] : undefined} />
      <View style={[styles.sheet, { backgroundColor: p.surface, paddingBottom: insets.bottom + space.sm, borderColor: p.border }]}>
        {(req.title || req.message) && (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.xs }}>
            {req.title && <T v="heading">{req.title}</T>}
            {req.message && <T muted>{req.message}</T>}
          </View>
        )}
        <ScrollView style={{ maxHeight: 420 }} bounces={false}>
          {choices.map(({ label, i }) => (
            <Pressable
              key={i}
              onPress={() => pick(i)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, { borderBottomColor: p.border, backgroundColor: pressed ? p.surfaceRaised : 'transparent' }]}>
              <T color={i === req.destructiveButtonIndex ? p.danger : p.text}>{label}</T>
            </Pressable>
          ))}
        </ScrollView>
        {req.cancelButtonIndex != null && (
          <Pressable
            onPress={cancel}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, styles.cancel, { backgroundColor: pressed ? p.border : p.surfaceRaised }]}>
            <T v="label" color={p.accent}>
              {req.options[req.cancelButtonIndex]}
            </T>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

function Prompt({ req }: { req: PromptRequest }) {
  const p = usePalette();
  const t = useT();
  const body = useScaledFont('body');
  const [text, setText] = useState(req.defaultValue ?? '');
  const finish = (value: string | undefined) => {
    show(null);
    req.onDone(value);
  };
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={() => finish(undefined)}>
      <View style={styles.center}>
        <View style={[styles.dialog, { backgroundColor: p.surface, borderColor: p.border }]}>
          <T v="heading">{req.title}</T>
          {req.message && <T muted>{req.message}</T>}
          <TextInput
            autoFocus
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => finish(text)}
            returnKeyType="done"
            maxFontSizeMultiplier={body.maxFontSizeMultiplier}
            style={[body.style, styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
            accessibilityLabel={req.title}
          />
          <View style={styles.buttons}>
            <Pressable onPress={() => finish(undefined)} accessibilityRole="button" style={styles.button}>
              <T v="label" color={p.accent}>
                {t.common.cancel}
              </T>
            </Pressable>
            <Pressable onPress={() => finish(text)} accessibilityRole="button" style={styles.button}>
              <T v="label" color={p.accent}>
                {t.common.ok}
              </T>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancel: { alignItems: 'center', borderBottomWidth: 0, marginTop: space.xs },
  center: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: space.lg },
  dialog: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: 12 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  button: { minHeight: 48, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
});
