import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { cameraUrl, doorbellUrl, eventKey, ringKey, splitAlertTitle } from '../src/alerts/live-activity-format.ts';

test('alert titles split into what was seen and the camera', () => {
  assert.deepEqual(splitAlertTitle("Someone's at the door · Front Door"), { headline: "Someone's at the door", camera: 'Front Door' });
  assert.deepEqual(splitAlertTitle('Person & Car · Drive · way'), { headline: 'Person & Car · Drive', camera: 'way' });
  assert.deepEqual(splitAlertTitle('Motion'), { headline: 'Motion', camera: '' });
});

test('deep links open the doorbell call screen and the camera', () => {
  assert.equal(
    doorbellUrl({ systemId: 'hub-1', cameraId: 'front door', at: '1700000000', reviewId: 'r/1' }),
    'sightline://doorbell?systemId=hub-1&cameraId=front%20door&at=1700000000&reviewId=r%2F1',
  );
  assert.equal(doorbellUrl({ systemId: 's', cameraId: 'c' }), 'sightline://doorbell?systemId=s&cameraId=c');
  assert.equal(cameraUrl('s', 'front door'), 'sightline://camera/s%3Afront%20door');
});

test('one activity per ring and per camera', () => {
  assert.equal(ringKey({ systemId: 's', cameraId: 'c', reviewId: 'r1' }), 'ring:r1');
  assert.equal(ringKey({ systemId: 's', cameraId: 'c', at: '5' }), 'ring:s:c:5');
  assert.equal(eventKey('s', 'c'), 'event:s:c');
});

// ActivityKit matches the app's activity to the widget's layout by this type, so the two
// copies must stay identical.
test('Live Activity attributes match between the app module and the widget', () => {
  const extract = (path: string) => {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const start = src.indexOf('struct SightlineActivityAttributes');
    assert.ok(start >= 0, path);
    const end = src.indexOf('\n}\n', start);
    return src
      .slice(start, end)
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .join('\n');
  };
  assert.equal(extract('../modules/live-activity/ios/LiveActivityModule.swift'), extract('../targets/widget/LiveActivity.swift'));
});

test('Info.plist declares Live Activity support', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.equal(app.expo.ios.infoPlist.NSSupportsLiveActivities, true);
});
