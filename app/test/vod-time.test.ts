import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clipSegments, playerToWall, wallToPlayer } from '../src/util/vod-time.ts';

test('wall/player mapping skips gaps and seams belong to the next recording', () => {
  const segs = clipSegments([{ start: 300, end: 400 }, { start: 100, end: 200 }], 150, 350);
  assert.deepEqual(segs, [{ start: 150, end: 200 }, { start: 300, end: 350 }]);
  assert.equal(wallToPlayer(segs, 250), 50);
  assert.equal(playerToWall(segs, 50), 300);
  for (const w of [150, 175, 300, 349]) assert.equal(playerToWall(segs, wallToPlayer(segs, w)), w);
});
