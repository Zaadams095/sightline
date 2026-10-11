import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
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
      {right ?? (onPress ? <T muted>›</T> : null)}
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

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: selected ? p.accent : p.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? p.accent : p.border,
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
