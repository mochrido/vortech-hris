/**
 * Server-side selfie validation (PRD §4, §7.5, §14; decisions.md #5).
 *
 * VALIDATION BOUNDARY — what the server checks vs trusts from the client:
 *
 * The browser is expected to produce a watermarked, resized JPEG via Canvas
 * (Task 9: longest edge <= 1280px, re-encoded at JPEG q80, <= 1MB). The
 * server MUST NOT trust any of that. Every byte is untrusted input, so this
 * module independently re-validates, with NO native image dependency:
 *
 *   1. Hard size ceiling: buffer must be <= 1 MB (1024*1024 bytes).
 *   2. File signature: JPEG SOI magic (0xFFD8) at the start and EOI
 *      (0xFFD9) at the very end of the byte stream.
 *   3. Container structure: the marker stream is walked segment by segment;
 *      any malformed/truncated segment, bad length, or out-of-range fill
 *      region rejects the buffer.
 *   4. Declared dimensions: read from the first SOF marker (SOF0/SOF1/SOF2/
 *      SOF3/SOF5/SOF6/SOF7/SOF9/SOF10/SOF11/SOF13/SOF14/SOF15); the longest
 *      edge must be <= 1280px and both dimensions must be > 0.
 *
 * What the server does NOT do (documented non-goals):
 *   - It does NOT decode pixels or re-encode the image. Full pixel re-encode
 *     is done client-side by the Canvas capture (Task 9); the server stores
 *     the validated blob as-is.
 *   - It does NOT trust Content-Type, filenames, or any client-supplied
 *     metadata — only the bytes themselves.
 *   - It does NOT check visual content (face/liveness); that is out of scope
 *     for the MVP (PRD §4 acceptance relies on capture-time UX).
 *
 * The result is a plain object (no throwing) so the API route (Task 7) can
 * map `ok:false` to AppError(VALIDATION_FAILED) in one place.
 */

/** decisions.md #5: hard selfie ceiling. */
export const SELFIE_MAX_BYTES = 1024 * 1024;

/** decisions.md #5: longest-edge ceiling after client-side resize. */
export const SELFIE_MAX_EDGE_PX = 1280;

export type ValidateSelfieResult =
  | { ok: true; width: number; height: number }
  | { ok: false; error: string };

interface SofInfo {
  width: number;
  height: number;
}

/** Marker codes that carry the Start Of Frame (dimension) segment. */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Markers with no length field (and 0x01 TEM). */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

function fail(error: string): ValidateSelfieResult {
  return { ok: false, error };
}

/**
 * Walks the JPEG marker stream and returns the dimensions declared by the
 * first SOF segment. Returns null when the stream is malformed or truncated.
 *
 * After SOS (0xDA) the entropy-coded scan data is NOT marker-structured; the
 * decoder must skip 0xFF-stuffed bytes and restart-marked regions to keep
 * looking for a SOF (multi-scan progressive files can carry several SOFs,
 * though the first is authoritative — we stop at the first SOF anyway).
 */
function findSof(buffer: Buffer): SofInfo | null {
  // Start after SOI.
  let offset = 2;
  // Bounded scan: a valid marker segment is at least 4 bytes; the 1MB cap
  // bounds this loop in practice, the cap below bounds it absolutely.
  let hops = 0;
  while (offset < buffer.length - 1 && hops < 4096) {
    hops += 1;

    // Expect a marker: 0xFF followed by a non-0x00 code. 0xFF fill bytes
    // (padding before a marker) are legal and skipped.
    if (buffer[offset] !== 0xff) return null;
    let code = buffer[offset + 1];
    if (code === 0x00) return null; // stuffed 0xFF00 is only valid in scan data, not here
    while (code === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      code = buffer[offset + 1];
    }

    if (STANDALONE_MARKERS.has(code)) {
      if (code === 0xd9) return null; // EOI reached with no SOF
      offset += 2;
      continue;
    }

    // All other markers carry a 2-byte big-endian length INCLUDING itself.
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const segmentEnd = offset + 2 + length;
    if (segmentEnd > buffer.length) return null;

    if (SOF_MARKERS.has(code)) {
      // SOF payload: precision(1), height(2), width(2), components(1), ...
      if (length < 8) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    if (code === 0xda) {
      // SOS: entropy-coded data follows until the next unstuffed marker.
      // Skip it so trailing SOFs / the EOI can still be found.
      offset = skipScanData(buffer, segmentEnd);
      if (offset < 0) return null;
      continue;
    }

    offset = segmentEnd;
  }
  return null;
}

/**
 * Skips entropy-coded scan data starting at `from` (just past the SOS
 * segment). Returns the offset of the next real marker, or -1 when the data
 * runs out without one (truncated file).
 */
function skipScanData(buffer: Buffer, from: number): number {
  let offset = from;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const code = buffer[offset + 1];
    if (code === 0x00) {
      // Stuffed byte: 0xFF00 represents a literal 0xFF in the data.
      offset += 2;
      continue;
    }
    if (code >= 0xd0 && code <= 0xd7) {
      // Restart marker: not length-coded, skip it.
      offset += 2;
      continue;
    }
    // A real marker begins here.
    return offset;
  }
  return -1;
}

/**
 * Validates an untrusted selfie upload. See the module header for the full
 * validation boundary. Pure function: no I/O, no throwing.
 */
export function validateSelfie(buffer: Buffer): ValidateSelfieResult {
  // (1) Hard size ceiling (decisions.md #5).
  if (buffer.length === 0) {
    return fail('selfie is empty');
  }
  if (buffer.length > SELFIE_MAX_BYTES) {
    return fail(`selfie exceeds the ${SELFIE_MAX_BYTES}-byte (1MB) size limit`);
  }

  // (2) File signature: SOI at the start, EOI at the very end.
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return fail('selfie is not a JPEG (missing SOI magic bytes)');
  }
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
    return fail('selfie is truncated or corrupt (missing EOI marker)');
  }

  // (3)+(4) Marker walk to the SOF segment for the declared dimensions.
  const sof = findSof(buffer);
  if (!sof) {
    return fail('selfie is truncated or corrupt (no valid SOF segment found)');
  }
  if (sof.width <= 0 || sof.height <= 0) {
    return fail('selfie declares invalid dimensions');
  }
  if (Math.max(sof.width, sof.height) > SELFIE_MAX_EDGE_PX) {
    return fail(`selfie dimensions exceed the ${SELFIE_MAX_EDGE_PX}px longest-edge limit`);
  }

  return { ok: true, width: sof.width, height: sof.height };
}
