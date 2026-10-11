import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

/** Same artwork, size and color as the native splash (app.json → expo-splash-screen). */
export const SPLASH_BG = '#080A14';
const SPLASH_IMAGE = require('../../assets/images/splash-logo.png');
const SPLASH_WIDTH = 300;

/**
 * Picks up exactly where the native launch screen leaves off (identical logo, size and
 * background), then eases the logo up, brings in the name, and dissolves into the app.
 * About a second, once per cold start; Reduce Motion gets a plain fade.
 */
export function BrandIntro({ ready }: { ready: boolean }) {
  const reduceMotion = useReducedMotion();
  const [imageReady, setImageReady] = useState(false);
  const [done, setDone] = useState(false);
  const lift = useSharedValue(0);
  const word = useSharedValue(0);
  const fade = useSharedValue(1);

  // Never hold the app on the splash if the image somehow doesn't report loading.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setImageReady(true), 900);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!ready || !imageReady) return;
    // Our first frame matches the native splash, so swapping them is invisible.
    void SplashScreen.hideAsync();
    const finish = () => setDone(true);
    if (reduceMotion) {
      fade.value = withDelay(150, withTiming(0, { duration: 250 }, (ok) => ok && runOnJS(finish)()));
      return;
    }
    const ease = Easing.bezier(0.22, 1, 0.36, 1);
    lift.value = withTiming(1, { duration: 550, easing: ease });
    word.value = withDelay(180, withTiming(1, { duration: 450, easing: ease }));
    fade.value = withDelay(950, withTiming(0, { duration: 320, easing: Easing.in(Easing.quad) }, (ok) => ok && runOnJS(finish)()));
  }, [ready, imageReady, reduceMotion, lift, word, fade]);

  const rootStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const logoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -34 * lift.value }, { scale: 1 - 0.12 * lift.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: word.value,
    transform: [{ translateY: 10 * (1 - word.value) }],
  }));

  if (done) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, rootStyle]} pointerEvents="none">
      <Animated.View style={logoStyle}>
        <Image
          source={SPLASH_IMAGE}
          style={{ width: SPLASH_WIDTH, height: SPLASH_WIDTH }}
          contentFit="contain"
          priority="high"
          onLoad={() => setImageReady(true)}
          onError={() => setImageReady(true)}
          accessibilityIgnoresInvertColors
        />
      </Animated.View>
      <View style={styles.wordmarkSlot}>
        <Animated.View style={wordStyle}>
          <Text style={styles.wordmark} allowFontScaling={false} accessibilityRole="header">
            Sightline
          </Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: SPLASH_BG, alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  // Sits just under the lifted logo without moving it off center beforehand.
  wordmarkSlot: { position: 'absolute', top: '50%', marginTop: SPLASH_WIDTH * 0.3, alignItems: 'center' },
  wordmark: { color: '#FFFFFF', fontSize: 34, fontWeight: '700', letterSpacing: 0.6 },
});
