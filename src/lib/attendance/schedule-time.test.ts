import test from 'node:test';
import assert from 'node:assert/strict';
import { localTimeToUtc, parseLocalMinutes } from './schedule.ts';

// ---------------------------------------------------------------------------
// localTimeToUtc
//
// Contract: converts a local wall-clock time to the UTC instant, and FAILS
// LOUDLY (throws) when the requested wall time is ambiguous or nonexistent
// (DST transitions). Never returns a silently-wrong instant.
// ---------------------------------------------------------------------------

// Fixed-offset zone: Asia/Jakarta (UTC+7, no DST) always converts directly.
test('localTimeToUtc converts a fixed-offset zone (Asia/Jakarta) correctly', () => {
  const d = localTimeToUtc('2026-08-06', '09:00', 'Asia/Jakarta');
  assert.equal(d.toISOString(), '2026-08-06T02:00:00.000Z');
});

// Jakarta crossing UTC midnight: local 00:30 is the previous UTC day.
test('localTimeToUtc handles Jakarta times near the UTC day boundary', () => {
  const d = localTimeToUtc('2026-08-06', '00:30', 'Asia/Jakarta');
  assert.equal(d.toISOString(), '2026-08-05T17:30:00.000Z');
});

// DST zone, a normal (unambiguous) time converts correctly. 2026-08-06 is in
// EDT (UTC-4) for America/New_York.
test('localTimeToUtc converts a normal time in a DST zone correctly', () => {
  const d = localTimeToUtc('2026-08-06', '09:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-08-06T13:00:00.000Z');
});

// Month-boundary correctness: 2026-11-01 00:30 in New York is EDT (UTC-4)
// => 04:30 UTC on the SAME local date. The naive `shown.day - day` heuristic
// breaks here because Oct has 31 days.
test('localTimeToUtc uses true calendar day diff across a month boundary', () => {
  const d = localTimeToUtc('2026-11-01', '00:30', 'America/New_York');
  assert.equal(d.toISOString(), '2026-11-01T04:30:00.000Z');
});

// Fall-back ambiguous hour: 2026-11-01 01:30 in America/New_York occurs twice
// (once in EDT UTC-4, once in EST UTC-5). There is no single correct answer,
// so the function must throw rather than silently pick a wrong instant.
test('localTimeToUtc throws on the ambiguous fall-back hour', () => {
  assert.throws(
    () => localTimeToUtc('2026-11-01', '01:30', 'America/New_York'),
    /ambiguous|does not exist|cannot|nonexist|not converge/i,
  );
});

// Spring-forward nonexistent hour: 2026-03-08 02:30 in America/New_York never
// happens (clocks jump 02:00 -> 03:00). Must throw rather than return a wrong
// wall time.
test('localTimeToUtc throws on the nonexistent spring-forward hour', () => {
  assert.throws(
    () => localTimeToUtc('2026-03-08', '02:30', 'America/New_York'),
    /ambiguous|does not exist|cannot|nonexist|not converge/i,
  );
});

// A nonexistent-hour in a fixed-offset zone is impossible; ensure no throw and
// correct value for a normal Jakarta time on the DST-relevant UTC dates.
test('localTimeToUtc is unaffected by DST-relevant UTC dates in fixed zones', () => {
  const d = localTimeToUtc('2026-03-08', '02:30', 'Asia/Jakarta');
  assert.equal(d.toISOString(), '2026-03-07T19:30:00.000Z');
});

// ---------------------------------------------------------------------------
// parseLocalMinutes (M3): malformed input must fail loudly.
// ---------------------------------------------------------------------------
test('parseLocalMinutes parses a valid HH:MM time', () => {
  assert.equal(parseLocalMinutes('09:30'), 570);
  assert.equal(parseLocalMinutes('00:00'), 0);
  assert.equal(parseLocalMinutes('23:59'), 1439);
});

test('parseLocalMinutes throws on malformed input', () => {
  assert.throws(() => parseLocalMinutes(''), /invalid|finite|malformed|number/i);
  assert.throws(() => parseLocalMinutes('abc'), /invalid|finite|malformed|number/i);
  assert.throws(() => parseLocalMinutes('9:xx'), /invalid|finite|malformed|number/i);
  assert.throws(() => parseLocalMinutes(':30'), /invalid|finite|malformed|number/i);
});
