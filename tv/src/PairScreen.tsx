import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { TvPairing } from '../modules/tv-pairing';
import { parsePairBody, redeem, type TvConfig } from './hub';
import { t } from './i18n';
import { colors } from './theme';

/**
 * "Scan this with your iPhone": the TV shows a QR code with its local address and a one-time
 * key; the Sightline app on the phone hands over a Hub invite for this TV (no cloud involved).
 */
export function PairScreen({ onPaired }: { onPaired: (c: TvConfig) => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!TvPairing) {
      setError(t.cantPair);
      return;
    }
    const pairing = TvPairing;
    let active = true;
    let key = '';
    const sub = pairing.addListener('onPairRequest', ({ id, body }) => {
      const req = parsePairBody(body);
      if (!req || req.key !== key) {
        pairing.respond(id, 400, JSON.stringify({ error: t.notFromSightline }));
        return;
      }
      setStatus(t.connectingTo(req.hub.name));
      setError(null);
      redeem(req)
        .then((config) => {
          pairing.setSecret('config', JSON.stringify(config));
          pairing.respond(id, 200, JSON.stringify({ ok: true }));
          pairing.stop();
          if (active) onPaired(config);
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          pairing.respond(id, 502, JSON.stringify({ error: message }));
          if (active) {
            setStatus(null);
            setError(message);
          }
        });
    });
    pairing
      .start()
      .then((info) => {
        if (!active) return;
        if (!info.host) {
          setError(t.noNetwork);
          return;
        }
        key = info.key;
        const link = `sightline://tv?h=${info.host}:${info.port}&k=${info.key}&n=${encodeURIComponent('Apple TV')}`;
        setAddress(`${info.host}:${info.port}`);
        setQr(`data:image/png;base64,${pairing.qrPng(link)}`);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
      sub.remove();
      pairing.stop();
    };
  }, [onPaired]);

  return (
    <View style={styles.root}>
      <View style={styles.text}>
        <Text style={styles.title}>Sightline</Text>
        <Text style={styles.heading}>{t.scanHeading}</Text>
        <Text style={styles.body}>{t.scanBody}</Text>
        {status && (
          <View style={styles.row}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.body}>{status}</Text>
          </View>
        )}
        {error && <Text style={[styles.body, { color: colors.danger }]}>{error}</Text>}
        {!!address && <Text style={styles.muted}>{t.thisTv(address)}</Text>}
      </View>
      <View style={styles.qrBox}>{qr ? <Image source={{ uri: qr }} style={styles.qr} /> : <ActivityIndicator size="large" color={colors.accent} />}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, flexDirection: 'row', alignItems: 'center', padding: 120, gap: 100 },
  text: { flex: 1, gap: 28 },
  title: { color: colors.accent, fontSize: 40, fontWeight: '700' },
  heading: { color: colors.text, fontSize: 64, fontWeight: '700' },
  body: { color: colors.text, fontSize: 32, lineHeight: 44 },
  muted: { color: colors.textMuted, fontSize: 26 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  qrBox: { width: 560, height: 560, borderRadius: 32, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 500, height: 500, resizeMode: 'contain' },
});
