import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { font, space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: ViewStyle;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const inner: ViewStyle = {
    padding: padded ? space.lg : 0,
    paddingBottom: insets.bottom + space.xxl,
    gap: space.lg,
  };
  if (!scroll) return <View style={[{ flex: 1, backgroundColor: p.bg }, inner, style]}>{children}</View>;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={[inner, style]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

type Variant = 'title' | 'heading' | 'body' | 'label' | 'caption';

export function T({
  v = 'body',
  muted,
  color,
  style,
  children,
  numberOfLines,
}: {
  v?: Variant;
  muted?: boolean;
  color?: string;
  style?: TextStyle;
  children: ReactNode;
  numberOfLines?: number;
}) {
  const p = usePalette();
  return (
    <Text numberOfLines={numberOfLines} style={[font[v], { color: color ?? (muted ? p.textMuted : p.text) }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const p = usePalette();
  return (
    <View
      style={[
        { backgroundColor: p.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border, overflow: 'hidden' },
        style,
      ]}>
      {children}
    </View>
  );
}

export function Section({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      {title && (
        <T v="caption" muted style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs }}>
          {title}
        </T>
      )}
      <Card>{children}</Card>
      {footer && (
        <T v="caption" muted style={{ marginHorizontal: space.xs }}>
          {footer}
        </T>
      )}
    </View>
  );
}

export function Row({
  label,
  detail,
  onPress,
  right,
  icon,
  destructive,
  last,
}: {
  label: string;
  detail?: string;
  onPress?: () => void;
  right?: ReactNode;
  icon?: ReactNode;
  destructive?: boolean;
  last?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        minHeight: 50,
        paddingVertical: space.sm,
        backgroundColor: pressed ? p.surfaceRaised : 'transparent',
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: p.border,
      })}>
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <T color={destructive ? p.danger : undefined}>{label}</T>
        {detail && (
          <T v="caption" muted numberOfLines={2}>
            {detail}
          </T>
        )}
      </View>
      {right ?? (onPress ? <SymbolView name="chevron.right" tintColor={p.textMuted} size={13} weight="semibold" /> : null)}
    </Pressable>
  );
}

export function ToggleRow({
  label,
  detail,
  value,
  onChange,
  last,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}) {
  const p = usePalette();
  return (
    <Row
      label={label}
      detail={detail}
      last={last}
      right={<Switch value={value} onValueChange={onChange} trackColor={{ true: p.accent }} />}
    />
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  loading,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const p = usePalette();
  const bg = { primary: p.accent, secondary: p.surfaceRaised, ghost: 'transparent', danger: p.danger }[kind];
  const fg = kind === 'primary' || kind === 'danger' ? p.accentText : kind === 'ghost' ? p.accent : p.text;
  return (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: 14,
          height: 52,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          borderWidth: kind === 'secondary' ? StyleSheet.hairlineWidth : 0,
          borderColor: p.border,
        },
        style,
      ]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[font.label, { color: fg, fontSize: 16 }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <T v="label" muted>
        {label}
      </T>
      <TextInput
        placeholderTextColor={p.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[
          font.body,
          {
            color: p.text,
            backgroundColor: p.surface,
            borderRadius: 12,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
            paddingHorizontal: space.md,
            paddingVertical: 14,
          },
          props.multiline && { minHeight: 120, textAlignVertical: 'top', fontFamily: 'Menlo', fontSize: 13 },
          props.style,
        ]}
      />
      {hint && (
        <T v="caption" muted>
          {hint}
        </T>
      )}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled: !!disabled }}
      // The pill is 36pt tall; the slop brings the tap target to 44pt.
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      style={{
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: selected ? p.accent : p.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? p.accent : p.border,
        opacity: disabled ? 0.45 : 1,
      }}>
      <T v="label" color={selected ? p.accentText : p.text}>
        {label}
      </T>
    </Pressable>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

/** A tappable heading that shows or hides extra (usually technical) content. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.md }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 }}>
        <SymbolView name={open ? 'chevron.down' : 'chevron.right'} tintColor={p.textMuted} size={13} weight="semibold" />
        <T v="label" muted>
          {title}
        </T>
      </Pressable>
      {open && children}
    </View>
  );
}

/** Icon-only button with a 44pt tap target and a spoken label. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  color,
  size = 18,
}: {
  icon: ComponentProps<typeof SymbolView>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  size?: number;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : pressed ? 0.6 : 1,
      })}>
      <SymbolView name={icon} tintColor={color ?? p.accent} size={size} weight="semibold" />
    </Pressable>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "23:00" → minutes after midnight (anything unreadable counts as midnight). */
function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/**
 * A time of day ("HH:MM") set with plain − / + buttons: one pair for the hour, one for the
 * minutes (15-minute steps). No keyboard, no format to get wrong.
 */
export function TimeStepper({ label, value, onChange, last }: { label: string; value: string; onChange: (hhmm: string) => void; last?: boolean }) {
  const p = usePalette();
  const mins = toMinutes(value);
  const set = (m: number) => {
    const v = ((m % 1440) + 1440) % 1440;
    onChange(`${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`);
  };
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  const shown = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const h = mins - (mins % 60);
  return (
    <View
      accessible={false}
      style={{
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        gap: space.xs,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: p.border,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }}>{label}</T>
        <T v="heading" style={{ fontVariant: ['tabular-nums'] }}>
          {shown}
        </T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.xs }}>
        <T v="caption" muted>
          Hour
        </T>
        <IconButton icon="minus.circle" label={`${label}: one hour earlier`} onPress={() => set(mins - 60)} size={22} />
        <IconButton icon="plus.circle" label={`${label}: one hour later`} onPress={() => set(mins + 60)} size={22} />
        <View style={{ width: space.md }} />
        <T v="caption" muted>
          Minutes
        </T>
        <IconButton icon="minus.circle" label={`${label}: 15 minutes earlier`} onPress={() => set(h + ((mins % 60) + 45) % 60)} size={22} />
        <IconButton icon="plus.circle" label={`${label}: 15 minutes later`} onPress={() => set(h + ((mins % 60) + 15) % 60)} size={22} />
      </View>
    </View>
  );
}
