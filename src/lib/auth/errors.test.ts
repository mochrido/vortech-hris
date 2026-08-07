import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ErrorCodes, toErrorResponse } from './errors.ts';

test('toErrorResponse collapses a non-AppError to INTERNAL_ERROR without leaking the message', () => {
  const internal = new Error('db connection string postgres://user:secret@host:5432/db');
  const out = toErrorResponse(internal);

  assert.equal(out.code, ErrorCodes.INTERNAL_ERROR);
  assert.notEqual(out.message, internal.message, 'must not echo the internal message');
  assert.ok(!out.message.includes('postgres'), 'must not leak connection-string details');
  assert.ok(!out.message.includes('db connection string'), 'must not leak internal details');
});

test('toErrorResponse returns {code, message} for an AppError', () => {
  const err = new AppError(ErrorCodes.RATE_LIMITED, 'Too many attempts, try again later', 429);
  const out = toErrorResponse(err);

  assert.equal(out.code, ErrorCodes.RATE_LIMITED);
  assert.equal(out.message, 'Too many attempts, try again later');
});

test('toErrorResponse output object contains no stack trace', () => {
  const out = toErrorResponse(new Error('boom'));

  // The client-facing shape is exactly {code, message}; no stack/detail fields.
  assert.deepEqual(Object.keys(out).sort(), ['code', 'message']);
  const serialized = JSON.stringify(out);
  assert.ok(!('stack' in out), 'must not expose a stack property');
  assert.ok(!serialized.includes('at '), 'serialized output must not contain a stack trace');
});
