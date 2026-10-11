import { Alert, View } from 'react-native';

import { ruleExplanation } from '@/alerts/learning';
import { isDoorbell } from '@/alerts/rules';
import { recordFeedback } from '@/alerts/smart';
import { IconButton } from '@/components/ui/primitives';
import { useSmart } from '@/state/smart';
import type { ReviewItem } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

/**
 * Thumbs on an event in Recordings: "Not important" teaches Sightline to stop alerting for
 * ones like it; "Always tell me about this" makes sure it never does. Not on doorbell rings.
 */
export function FeedbackButtons({ item, cameraName }: { item: ReviewItem; cameraName: string }) {
  const p = usePalette();
  const verdict = useSmart((s) => s.learning.feedback.find((f) => f.id === item.id && f.camera === `${item.systemId}:${item.cameraId}`)?.verdict ?? null);
  if (isDoorbell(item)) return null;

  const give = (v: 'not-important' | 'important') => {
    const rule = recordFeedback(item, v);
    if (!rule) return;
    const { forget, confirm } = useSmart.getState();
    if (rule.needsConfirm) {
      Alert.alert('Stop alerting for these?', ruleExplanation(rule, cameraName), [
        { text: 'Keep alerting', style: 'cancel', onPress: () => forget(rule) },
        { text: 'Stop alerting', onPress: () => confirm(rule.key) },
      ]);
    } else {
      Alert.alert('Sightline learned something', ruleExplanation(rule, cameraName), [
        { text: 'Undo', style: 'destructive', onPress: () => forget(rule) },
        { text: 'OK' },
      ]);
    }
  };

  return (
    <View style={{ flexDirection: 'row' }}>
      <IconButton
        icon={verdict === 'not-important' ? 'hand.thumbsdown.fill' : 'hand.thumbsdown'}
        label={verdict === 'not-important' ? 'Marked not important' : 'Not important'}
        color={verdict === 'not-important' ? p.accent : p.textMuted}
        size={16}
        onPress={() => give('not-important')}
      />
      <IconButton
        icon={verdict === 'important' ? 'hand.thumbsup.fill' : 'hand.thumbsup'}
        label={verdict === 'important' ? 'You’ll always be told about this' : 'Always tell me about this'}
        color={verdict === 'important' ? p.accent : p.textMuted}
        size={16}
        onPress={() => give('important')}
      />
    </View>
  );
}
