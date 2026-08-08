import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSelfie } from './selfie.ts';

// ---------------------------------------------------------------------------
// Test fixtures: hand-built JPEG byte streams (no image library needed).
//
// A minimal baseline JPEG is: SOI, APP0 (JFIF), SOF0 (dimensions), EOI.
// The validator must walk markers to find the SOF segment and read the
// declared dimensions from it — the server does NOT trust the client.
// ---------------------------------------------------------------------------

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** Builds a minimal JPEG-like buffer with one SOF segment of `marker`. */
function makeJpeg(opts: { width: number; height: number; sofMarker?: number }): Buffer {
  const { width, height, sofMarker = 0xc0 } = opts;
  const bytes: number[] = [...SOI];
  // APP0: JFIF header.
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  // SOF: length 8 (8-bit precision, 1 component), big-endian height then width.
  bytes.push(0xff, sofMarker, 0x00, 0x08, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01);
  bytes.push(...EOI);
  return Buffer.from(bytes);
}

test('selfie: accepts a valid small JPEG and reports its dimensions', () => {
  const result = validateSelfie(makeJpeg({ width: 640, height: 480 }));

  assert.deepEqual(result, { ok: true, width: 640, height: 480 });
});

test('selfie: accepts a JPEG at exactly the 1280px longest-edge limit', () => {
  const result = validateSelfie(makeJpeg({ width: 1280, height: 960 }));

  assert.deepEqual(result, { ok: true, width: 1280, height: 960 });
});

test('selfie: accepts progressive (SOF2) JPEGs and zero-dimension edge stays valid shape', () => {
  const result = validateSelfie(makeJpeg({ width: 800, height: 600, sofMarker: 0xc2 }));

  assert.deepEqual(result, { ok: true, width: 800, height: 600 });
});

test('selfie: rejects a buffer that is not a JPEG (bad magic bytes)', () => {
  // PNG magic header.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const result = validateSelfie(png);

  assert.equal(result.ok, false);
  assert.ok(result.error && /jpeg|magic|format/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects a buffer larger than 1MB', () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1, 0x00);
  // Give it valid magic bytes so ONLY the size check can fail.
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  oversized[oversized.length - 2] = 0xff;
  oversized[oversized.length - 1] = 0xd9;

  const result = validateSelfie(oversized);

  assert.equal(result.ok, false);
  assert.ok(result.error && /size|1\s?mb|large/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects a JPEG whose SOF declares a longest edge over 1280px', () => {
  const result = validateSelfie(makeJpeg({ width: 2000, height: 1500 }));

  assert.equal(result.ok, false);
  assert.ok(result.error && /dimension|1280|resolution/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects a portrait JPEG whose height exceeds 1280px (longest edge is not just width)', () => {
  const result = validateSelfie(makeJpeg({ width: 900, height: 1300 }));

  assert.equal(result.ok, false);
  assert.ok(result.error && /dimension|1280|resolution/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects a truncated/corrupt JPEG (SOI but no SOF or EOI)', () => {
  const truncated = Buffer.from([...SOI, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const result = validateSelfie(truncated);

  assert.equal(result.ok, false);
  assert.ok(result.error && /truncat|corrupt|invalid|incomplete|unexpected end/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects a JPEG with SOF but no EOI terminator', () => {
  const bytes = makeJpeg({ width: 640, height: 480 });
  const noEoi = bytes.subarray(0, bytes.length - 2);

  const result = validateSelfie(noEoi);

  assert.equal(result.ok, false);
  assert.ok(result.error && /truncat|corrupt|invalid|incomplete|eoi|unexpected end/i.test(result.error), `unexpected error: ${result.error}`);
});

test('selfie: rejects an empty buffer', () => {
  const result = validateSelfie(Buffer.alloc(0));

  assert.equal(result.ok, false);
  assert.ok(result.error);
});
