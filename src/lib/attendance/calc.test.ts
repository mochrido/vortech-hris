import test from 'node:test';
import assert from 'node:assert/strict';
import { lateMinutes, workedMinutes } from './calc.ts';

const MINUTE = 60 * 1000;

test('lateMinutes returns 0 when check-in is at or before scheduled start plus grace', () => {
  const start = new Date('2026-08-06T09:00:00Z');
  // Exactly at scheduled start
  assert.equal(lateMinutes(new Date(start.getTime()), start, 10), 0);
  // Before scheduled start
  assert.equal(lateMinutes(new Date(start.getTime() - 30 * MINUTE), start, 10), 0);
  // Within grace period
  assert.equal(lateMinutes(new Date(start.getTime() + 7 * MINUTE), start, 10), 0);
  // Exactly at start + grace boundary
  assert.equal(lateMinutes(new Date(start.getTime() + 10 * MINUTE), start, 10), 0);
});

test('lateMinutes returns exact whole minutes late beyond the grace period', () => {
  const start = new Date('2026-08-06T09:00:00Z');
  // 10-minute grace, check in 25 minutes after start -> 15 minutes late
  assert.equal(lateMinutes(new Date(start.getTime() + 25 * MINUTE), start, 10), 15);
  // 1 minute past grace
  assert.equal(lateMinutes(new Date(start.getTime() + 11 * MINUTE), start, 10), 1);
});

test('lateMinutes floors partial minutes', () => {
  const start = new Date('2026-08-06T09:00:00Z');
  // 90 seconds past grace -> 1 whole minute late
  assert.equal(lateMinutes(new Date(start.getTime() + 10 * MINUTE + 90 * 1000), start, 10), 1);
});

test('workedMinutes returns elapsed minutes minus break', () => {
  const checkIn = new Date('2026-08-06T09:00:00Z');
  const checkOut = new Date('2026-08-06T17:30:00Z'); // 510 minutes elapsed
  assert.equal(workedMinutes(checkIn, checkOut, 60), 450);
  assert.equal(workedMinutes(checkIn, checkOut, 0), 510);
});

test('workedMinutes floors at 0 when break exceeds elapsed time', () => {
  const checkIn = new Date('2026-08-06T09:00:00Z');
  const checkOut = new Date('2026-08-06T09:30:00Z'); // 30 minutes elapsed
  assert.equal(workedMinutes(checkIn, checkOut, 60), 0);
});

test('workedMinutes returns 0 when check-out is at or before check-in', () => {
  const checkIn = new Date('2026-08-06T09:00:00Z');
  assert.equal(workedMinutes(checkIn, new Date(checkIn.getTime()), 0), 0);
  assert.equal(workedMinutes(checkIn, new Date(checkIn.getTime() - 60 * MINUTE), 0), 0);
});
