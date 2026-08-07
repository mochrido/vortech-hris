import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, isInsideGeofence } from './geo.ts';

test('haversineMeters returns ~111195 m for 1 degree of latitude', () => {
  const distance = haversineMeters(0, 0, 1, 0);
  // 1 degree of latitude on Earth radius 6371000 m = ~111194.9 m
  assert.ok(Math.abs(distance - 111195) < 5, `expected ~111195 m, got ${distance}`);
});

test('haversineMeters returns 0 for identical points', () => {
  assert.equal(haversineMeters(-6.2, 106.816, -6.2, 106.816), 0);
});

test('haversineMeters returns a known short distance', () => {
  // ~157.2 m between these two Jakarta-area points
  const distance = haversineMeters(-6.2, 106.816, -6.201, 106.817);
  assert.ok(Math.abs(distance - 157.2) < 1, `expected ~157.2 m, got ${distance}`);
});

test('isInsideGeofence returns true when distance to a location is within its radius_m', () => {
  const locations = [{ latitude: -6.2, longitude: 106.816, radius_m: 150 }];
  // Same point: distance 0 <= 150
  assert.equal(isInsideGeofence(-6.2, 106.816, locations), true);
});

test('isInsideGeofence treats a point exactly on the radius as inside (<=)', () => {
  // 1 degree of latitude = ~111194.9 m; use radius 111195 so the point sits just inside the boundary
  const locations = [{ latitude: 0, longitude: 0, radius_m: 111195 }];
  assert.equal(isInsideGeofence(1, 0, locations), true);

  // And a radius one meter below the distance is outside
  const tighter = [{ latitude: 0, longitude: 0, radius_m: 111194 }];
  assert.equal(isInsideGeofence(1, 0, tighter), false);
});

test('isInsideGeofence returns false when beyond all locations', () => {
  const locations = [
    { latitude: -6.2, longitude: 106.816, radius_m: 100 },
    { latitude: -6.914744, longitude: 107.60981, radius_m: 100 },
  ];
  // Far away from both
  assert.equal(isInsideGeofence(0, 0, locations), false);
});

test('isInsideGeofence returns true when inside ANY one of multiple locations', () => {
  const locations = [
    { latitude: -6.914744, longitude: 107.60981, radius_m: 100 }, // Bandung, far away
    { latitude: -6.2, longitude: 106.816, radius_m: 150 }, // Jakarta, contains the point
  ];
  assert.equal(isInsideGeofence(-6.2, 106.816, locations), true);
});

test('isInsideGeofence returns false for an empty locations array', () => {
  assert.equal(isInsideGeofence(-6.2, 106.816, []), false);
});

test('isInsideGeofence ignores locations whose radius_m is null', () => {
  const locations = [{ latitude: -6.2, longitude: 106.816, radius_m: null as unknown as number }];
  assert.equal(isInsideGeofence(-6.2, 106.816, locations), false);
});
