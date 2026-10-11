import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeZone,
  gridFromZones,
  legacyMasks,
  migrateMasks,
  nearestVertex,
  nextZoneId,
  objectCategory,
  pointInPolygon,
  rasterize,
  ZONE_PRESETS,
  zoneSupportFor,
  zonesAllow,
  type AlertZone,
} from '../src/alerts/zones.ts';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const left = rect(0, 0, 0.5, 1);
const right = rect(0.5, 0, 1, 1);
const zone = (over: Partial<AlertZone>): AlertZone => ({ id: 'z', name: 'Zone', mode: 'include', points: right, objects: [], ...over });

test('point in polygon, including a concave shape', () => {
  const ell = [
    { x: 0, y: 0 },
    { x: 0.3, y: 0 },
    { x: 0.3, y: 0.7 },
    { x: 1, y: 0.7 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  assert.equal(pointInPolygon({ x: 0.25, y: 0.5 }, left), true);
  assert.equal(pointInPolygon({ x: 0.75, y: 0.5 }, left), false);
  assert.equal(pointInPolygon({ x: 0.1, y: 0.1 }, ell), true);
  assert.equal(pointInPolygon({ x: 0.8, y: 0.9 }, ell), true);
  assert.equal(pointInPolygon({ x: 0.8, y: 0.3 }, ell), false);
  assert.equal(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), false);
});

test('object labels map to zone categories', () => {
  assert.equal(objectCategory('car'), 'vehicle');
  assert.equal(objectCategory('Truck'), 'vehicle');
  assert.equal(objectCategory('dog'), 'animal');
  assert.equal(objectCategory('person'), 'person');
  assert.equal(objectCategory('package'), 'package');
});

test('include and exclude zones filter by foot position and object kind', () => {
  const driveway = zone({ name: 'Driveway', points: right, objects: ['vehicle'] });
  const porch = zone({ name: 'Porch', points: left, objects: ['person'] });
  const street = zone({ name: 'Street', mode: 'exclude', points: left });
  const streetCars = zone({ name: 'Street', mode: 'exclude', points: left, objects: ['vehicle'] });
  const inLeft = [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.6 }];
  const inRight = [{ x: 0.7, y: 0.5 }];
  const crossing = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];

  assert.equal(zonesAllow([], ['car'], inLeft), true);
  assert.equal(zonesAllow([driveway], ['person'], []), true, 'unknown positions never suppress');
  assert.equal(zonesAllow([street], ['car'], inLeft), false, 'stayed in the ignored area');
  assert.equal(zonesAllow([street], ['car'], crossing), true, 'left the ignored area');
  assert.equal(zonesAllow([streetCars], ['person'], inLeft), true, 'exclude for cars only');
  assert.equal(zonesAllow([streetCars], ['car'], inLeft), false);
  assert.equal(zonesAllow([driveway], ['car'], inRight), true);
  assert.equal(zonesAllow([driveway], ['car'], inLeft), false, 'outside the driveway');
  assert.equal(zonesAllow([driveway], ['person'], inRight), false, 'driveway is only about vehicles');
  assert.equal(zonesAllow([driveway, porch], ['person'], inLeft), true);
  assert.equal(zonesAllow([zone({})], [], inRight), true, 'any motion');
  assert.equal(zonesAllow([zone({}), zone({ mode: 'exclude' })], [], inRight), false, 'exclude wins where they overlap');
  assert.equal(zonesAllow([zone({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })], [], inLeft), true, 'degenerate zones ignored');
  assert.equal(zonesAllow([zone({ objects: ['animal'] })], ['dog'], inRight), true);
});

test('old masks migrate to "ignore here" zones, once', () => {
  const masks = { 'sys:front': [left, [{ x: 0, y: 0 }]], 'sys:back': [right, left], 'sys:empty': [] };
  const zones = migrateMasks(masks, undefined);
  assert.deepEqual(Object.keys(zones).sort(), ['sys:back', 'sys:front']);
  assert.equal(zones['sys:front'].length, 1, 'shapes with fewer than 3 points are dropped');
  assert.deepEqual(zones['sys:front'][0], { id: 'mask-1', name: 'Ignored area', mode: 'exclude', points: left, objects: [] });
  assert.deepEqual(
    zones['sys:back'].map((z) => z.name),
    ['Ignored area 1', 'Ignored area 2'],
  );
  // Idempotent, and never overwrites zones a camera already has.
  assert.deepEqual(migrateMasks(masks, zones), zones);
  const mine = { 'sys:front': [zone({ name: 'Driveway' })] };
  assert.equal(migrateMasks(masks, mine)['sys:front'][0].name, 'Driveway');
  assert.deepEqual(migrateMasks(undefined, undefined), {});
  // Same filtering as the Hub's old mask logic.
  assert.equal(zonesAllow(zones['sys:front'], ['car'], [{ x: 0.2, y: 0.5 }]), false);
});

test('legacy masks for older Hubs only carry plain "ignore here" zones', () => {
  const z = [zone({ mode: 'exclude', points: left }), zone({ mode: 'exclude', points: right, objects: ['vehicle'] }), zone({ points: right })];
  assert.deepEqual(legacyMasks(z), [left]);
});

test('rasterize: include area minus exclude areas, row-major from the top-left', () => {
  assert.equal(rasterize([], 4, 2), '11111111');
  assert.equal(rasterize([zone({ points: right })], 4, 2), '00110011');
  assert.equal(rasterize([zone({ mode: 'exclude', points: rect(0, 0, 1, 0.5) })], 4, 2), '00001111');
  assert.equal(rasterize([zone({ points: right }), zone({ mode: 'exclude', points: rect(0, 0.5, 1, 1) })], 4, 2), '00110000');
});

test('device grids are only rewritten in the shape the device reported', () => {
  const zones = [zone({ points: right })];
  assert.deepEqual(gridFromZones({ cols: 4, rows: 2, table: '11111111' }, zones), { cols: 4, rows: 2, table: '00110011' });
  assert.equal(gridFromZones({ cols: 4, rows: 2, table: '111' }, zones), null);
  assert.equal(gridFromZones({ cols: 4, rows: 2, table: 'ffffffff' }, zones), null);
  assert.equal(gridFromZones({ cols: '80', rows: 60 } as never, zones), null);
  assert.equal(gridFromZones(undefined, zones), null);
});

test('zone support follows what the system can do', () => {
  assert.equal(zoneSupportFor({ detectionPoints: () => [] }, {}), 'precise');
  assert.equal(zoneSupportFor({ applyZones: () => '' }, {}), 'device');
  assert.equal(zoneSupportFor({}, {}), false);
  const hub = { zoneSupport: (c: { detectSize?: object }) => (c.detectSize ? ('precise' as const) : false) };
  assert.equal(zoneSupportFor(hub, { detectSize: { width: 1, height: 1 } }), 'precise');
  assert.equal(zoneSupportFor(hub, {}), false);
});

test('editor helpers', () => {
  const pts = rect(0.1, 0.1, 0.9, 0.9);
  assert.equal(nearestVertex(pts, { x: 0.12, y: 0.11 }, 0.05), 0);
  assert.equal(nearestVertex(pts, { x: 0.5, y: 0.5 }, 0.05), -1);
  assert.equal(nearestVertex(pts, { x: 0.88, y: 0.88 }, 0.05), 2);
  assert.equal(nextZoneId([zone({ id: 'z1' }), zone({ id: 'z3' })]), 'z4');
  assert.equal(nextZoneId([zone({ id: 'z2' })]), 'z3');
  assert.equal(nextZoneId([]), 'z1');
  assert.equal(describeZone(zone({ objects: ['vehicle'] })), 'Alert only for vehicles here');
  assert.equal(describeZone(zone({ mode: 'exclude' })), 'Ignore everything here');
  assert.equal(describeZone(zone({ mode: 'exclude', objects: ['person', 'animal', 'vehicle'] })), 'Ignore people, animals and vehicles here');
  for (const p of ZONE_PRESETS) assert.ok(p.points.every((q) => q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1), p.label);
});
