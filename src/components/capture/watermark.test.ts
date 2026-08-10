import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWatermarkLines,
  computeCaptureSize,
  computeWatermarkBandHeight,
  matchLocation,
} from './watermark.ts';

const HQ = { id: 'loc-hq', name: 'Kantor Pusat Jakarta', latitude: -6.2, longitude: 106.816666, radiusM: 100 };
const BRANCH = { id: 'loc-bdg', name: 'Kantor Cabang Bandung', latitude: -6.914744, longitude: 107.60981, radiusM: 150 };

// 2026-08-06T01:30:00Z is 08:30 in Asia/Jakarta (UTC+7, no DST).
const TIMESTAMP = new Date('2026-08-06T01:30:00.000Z');

test('watermark lines include timestamp, name, coords and matched location label', () => {
  const lines = buildWatermarkLines({
    displayName: 'Demo Member',
    timestamp: TIMESTAMP,
    latitude: -6.2,
    longitude: 106.816666,
    accuracyM: 18,
    locations: [HQ],
  });

  assert.equal(lines.length, 4);
  assert.equal(lines[0], '06/08/2026 · 08:30 WIB');
  assert.equal(lines[1], 'Demo Member');
  assert.equal(lines[2], 'GPS -6.20000, 106.81667 (±18 m)');
  assert.equal(lines[3], 'Area: Kantor Pusat Jakarta');
});

test('watermark lines never contain empty entries', () => {
  const lines = buildWatermarkLines({
    displayName: 'Demo Member',
    timestamp: TIMESTAMP,
    latitude: -6.2,
    longitude: 106.816666,
    accuracyM: 18,
    locations: [HQ],
  });
  for (const line of lines) {
    assert.ok(line.trim().length > 0, 'line must not be empty');
  }
});

test('watermark marks a fix outside every location with the nearest distance', () => {
  // ~11 km south of HQ: outside its 100 m radius.
  const lines = buildWatermarkLines({
    displayName: 'Demo Member',
    timestamp: TIMESTAMP,
    latitude: -6.3,
    longitude: 106.816666,
    accuracyM: 25,
    locations: [HQ, BRANCH],
  });

  assert.ok(lines[3].startsWith('Di luar area terdaftar'), `unexpected line: ${lines[3]}`);
  assert.ok(lines[3].includes('Kantor Pusat Jakarta'), 'nearest location name should appear');
});

test('watermark without a GPS fix says so instead of printing coordinates', () => {
  const lines = buildWatermarkLines({
    displayName: 'Demo Member',
    timestamp: TIMESTAMP,
    latitude: null,
    longitude: null,
    accuracyM: null,
    locations: [HQ],
  });

  assert.equal(lines[2], 'GPS tidak tersedia');
  assert.equal(lines[3], 'Lokasi tidak diverifikasi');
});

test('watermark with a fix but no assigned locations says no location is registered', () => {
  const lines = buildWatermarkLines({
    displayName: 'Demo Member',
    timestamp: TIMESTAMP,
    latitude: -6.2,
    longitude: 106.816666,
    accuracyM: 18,
    locations: [],
  });

  assert.equal(lines[3], 'Tidak ada lokasi terdaftar');
});

test('matchLocation treats a fix exactly on the radius boundary as inside', () => {
  // ~100 m north of HQ: 0.0009 degrees latitude ≈ 100.07 m — just over; use a
  // slightly smaller offset to land inside, and compute the boundary from the
  // matched distance instead of hard-coding meters.
  const inside = matchLocation(-6.2, 106.816666, [HQ]);
  assert.equal(inside.inside, true);
  assert.equal(inside.matched?.id, HQ.id);
  assert.equal(inside.distanceM, 0);

  const outside = matchLocation(-6.20001, 106.816666, []);
  assert.equal(outside.inside, false);
  assert.equal(outside.matched, null);
  assert.equal(outside.distanceM, null);
});

test('matchLocation picks the nearest location when several are assigned', () => {
  const match = matchLocation(-6.914744, 107.60981, [HQ, BRANCH]);
  assert.equal(match.inside, true);
  assert.equal(match.matched?.id, BRANCH.id);
});

test('computeCaptureSize shrinks a 4000x3000 photo to the 1280px longest edge, aspect preserved', () => {
  assert.deepEqual(computeCaptureSize(4000, 3000), { width: 1280, height: 960 });
  assert.deepEqual(computeCaptureSize(3000, 4000), { width: 960, height: 1280 });
});

test('computeCaptureSize leaves already-small images unchanged', () => {
  assert.deepEqual(computeCaptureSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(computeCaptureSize(1280, 720), { width: 1280, height: 720 });
});

test('computeCaptureSize rejects invalid source dimensions', () => {
  assert.throws(() => computeCaptureSize(0, 600));
  assert.throws(() => computeCaptureSize(Number.NaN, 600));
});

test('computeWatermarkBandHeight is proportional but clamped to a readable band', () => {
  assert.equal(computeWatermarkBandHeight(960), 134);
  assert.equal(computeWatermarkBandHeight(200), 56);
  assert.equal(computeWatermarkBandHeight(4000), 140);
});
